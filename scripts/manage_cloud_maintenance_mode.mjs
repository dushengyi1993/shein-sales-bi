#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {writeFileAtomic} from '../lib/atomic_file_publish.mjs';
import {
  CLOUD_MAINTENANCE_EXIT_CODES,
  CloudMaintenanceConfigurationError,
  DEFAULT_CLOUD_MAINTENANCE_FILE,
  checkCloudMaintenance,
  pauseCloudMaintenance,
  readCloudMaintenanceStatus,
  resumeCloudMaintenance,
} from '../lib/cloud_maintenance_mode.mjs';
import {
  CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  validateCloudMaintenanceEffectiveGuards,
  validateCloudServicePolicyContract,
} from '../lib/cloud_runtime_inventory.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_INSTALL_CONFIRMATION = 'APPLY_CLOUD_MAINTENANCE_GUARDS_V1';

class CloudMaintenanceGuardInstallError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'CloudMaintenanceGuardInstallError';
    this.code = 'CLOUD_MAINTENANCE_GUARD_INSTALL_FAILED';
    this.exitCode = 1;
    this.detail = detail;
  }
}

function parseGuardInstallArgs(argv) {
  const args = {
    command: 'install-guards',
    apply: false,
    confirm: '',
    systemdRoot: process.env.SHEIN_BI_SYSTEMD_ROOT || '/etc/systemd/system',
    systemctlBin: process.env.SHEIN_BI_SYSTEMCTL_BIN || 'systemctl',
  };
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (seen.has(option)) throw new CloudMaintenanceConfigurationError(`duplicate argument: ${option}`);
    seen.add(option);
    if (option === '--apply') {
      args.apply = true;
      continue;
    }
    if (!['--confirm', '--systemd-root'].includes(option)) {
      throw new CloudMaintenanceConfigurationError(`unknown argument: ${option}`);
    }
    if (i + 1 >= argv.length) throw new CloudMaintenanceConfigurationError(`missing value for ${option}`);
    const value = String(argv[++i]);
    if (option === '--confirm') args.confirm = value;
    else args.systemdRoot = value;
  }
  if (!path.isAbsolute(args.systemdRoot)) {
    throw new CloudMaintenanceConfigurationError('--systemd-root must be absolute');
  }
  args.systemdRoot = path.resolve(args.systemdRoot);
  if (args.systemdRoot === path.parse(args.systemdRoot).root) {
    throw new CloudMaintenanceConfigurationError('unsafe --systemd-root');
  }
  args.systemctlBin = String(args.systemctlBin || '').trim();
  if (!args.systemctlBin) throw new CloudMaintenanceConfigurationError('systemctl command is required');
  if (args.apply) {
    if (args.confirm !== GUARD_INSTALL_CONFIRMATION) {
      throw new CloudMaintenanceConfigurationError(
        `--apply requires exact --confirm ${GUARD_INSTALL_CONFIRMATION}`,
      );
    }
  } else if (args.confirm) {
    throw new CloudMaintenanceConfigurationError('--confirm is valid only with --apply');
  }
  return args;
}

function parseArgs(argv) {
  const command = String(argv[0] || '').trim().toLowerCase();
  if (!['pause', 'resume', 'status', 'check', 'systemd-condition', 'policy', 'install-guards'].includes(command)) {
    throw new CloudMaintenanceConfigurationError('usage: manage_cloud_maintenance_mode.mjs <pause|resume|status|check|systemd-condition|policy|install-guards> [options]');
  }
  if (command === 'install-guards') return parseGuardInstallArgs(argv);
  const args = {
    command,
    markerFile: DEFAULT_CLOUD_MAINTENANCE_FILE,
    mode: '',
    reason: '',
    requestedBy: '',
    expectedGeneration: undefined,
    expectedHash: '',
    unitClass: '',
    unit: '',
    systemdSource: '',
    systemdRoot: process.env.SHEIN_BI_SYSTEMD_ROOT || '/etc/systemd/system',
    systemctlBin: process.env.SHEIN_BI_SYSTEMCTL_BIN || 'systemctl',
    format: 'json',
  };
  const withValue = new Set([
    '--file', '--marker-file', '--mode', '--reason', '--requested-by',
    '--expected-generation', '--expected-hash', '--class', '--unit', '--systemd-source', '--systemd-root', '--format',
  ]);
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const option = argv[i];
    if (!withValue.has(option)) throw new CloudMaintenanceConfigurationError(`unknown argument: ${option}`);
    if (i + 1 >= argv.length) throw new CloudMaintenanceConfigurationError(`missing value for ${option}`);
    const canonicalOption = option === '--file' ? '--marker-file' : option;
    if (seen.has(canonicalOption)) throw new CloudMaintenanceConfigurationError(`duplicate argument: ${canonicalOption}`);
    seen.add(canonicalOption);
    const value = String(argv[++i]);
    if (option === '--file' || option === '--marker-file') args.markerFile = path.resolve(value);
    else if (option === '--mode') args.mode = value;
    else if (option === '--reason') args.reason = value;
    else if (option === '--requested-by') args.requestedBy = value;
    else if (option === '--expected-generation') args.expectedGeneration = value;
    else if (option === '--expected-hash') args.expectedHash = value;
    else if (option === '--class') args.unitClass = value;
    else if (option === '--unit') args.unit = value;
    else if (option === '--systemd-source') args.systemdSource = path.resolve(value);
    else if (option === '--systemd-root') args.systemdRoot = path.resolve(value);
    else if (option === '--format') args.format = value;
  }
  const allowedOptions = {
    status: new Set(['--marker-file']),
    check: new Set(['--marker-file', '--class', '--unit']),
    'systemd-condition': new Set(['--marker-file', '--class', '--unit']),
    policy: new Set(['--systemd-source', '--format']),
    pause: new Set(['--marker-file', '--mode', '--reason', '--requested-by', '--expected-generation', '--expected-hash', '--systemd-root']),
    resume: new Set(['--marker-file', '--reason', '--requested-by', '--expected-generation', '--expected-hash']),
  }[command];
  for (const option of seen) {
    if (!allowedOptions.has(option)) {
      throw new CloudMaintenanceConfigurationError(`${option} is not valid for ${command}`);
    }
  }
  if (command === 'pause' && (!path.isAbsolute(args.systemdRoot)
    || path.resolve(args.systemdRoot) === path.parse(path.resolve(args.systemdRoot)).root)) {
    throw new CloudMaintenanceConfigurationError('pause --systemd-root must be a safe absolute directory');
  }
  return args;
}

async function repositoryServicePolicies(systemdSource) {
  if (!systemdSource) throw new CloudMaintenanceConfigurationError('policy requires --systemd-source');
  const entries = await fs.readdir(systemdSource, {withFileTypes: true});
  const repositoryServices = entries
    .filter(entry => entry.isFile() && /^shein-bi-[A-Za-z0-9_.@-]+\.service$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const contract = validateCloudServicePolicyContract(
    repositoryServices,
    CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
  );
  if (!contract.ok) {
    throw new CloudMaintenanceConfigurationError('repository service policy contract is invalid', {
      issues: contract.issues,
    });
  }
  return repositoryServices.map(service => ({
    service,
    class: CLOUD_MAINTENANCE_POLICY_BY_SERVICE[service],
  }));
}

function guardTemplateText(unitClass) {
  return `[Service]\nExecCondition=/usr/bin/node /opt/shein-bi/app/scripts/manage_cloud_maintenance_mode.mjs systemd-condition --class ${unitClass} --unit %n\n`;
}

async function lstatIfExists(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRealDirectory(file, {allowMissing = false} = {}) {
  const stat = await lstatIfExists(file);
  if (!stat && allowMissing) return false;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CloudMaintenanceGuardInstallError(`directory is missing or unsafe: ${file}`);
  }
  return true;
}

async function readTrackedGuardTemplates(systemdSource) {
  const templates = {};
  for (const unitClass of ['scheduled', 'infrastructure']) {
    const file = path.join(systemdSource, `shein-bi-${unitClass}-maintenance-guard.conf`);
    const stat = await lstatIfExists(file);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new CloudMaintenanceGuardInstallError(`tracked template missing or unsafe: ${file}`);
    }
    const content = await fs.readFile(file, 'utf8');
    if (content !== guardTemplateText(unitClass)) {
      throw new CloudMaintenanceGuardInstallError(`tracked template content mismatch for class=${unitClass}`);
    }
    templates[unitClass] = {file, content};
  }
  return templates;
}

async function inspectKnownGuard(file, templates) {
  const stat = await lstatIfExists(file);
  if (!stat) return {exists: false, class: ''};
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new CloudMaintenanceGuardInstallError(`guard target is not a regular non-symlink file: ${file}`);
  }
  const content = await fs.readFile(file, 'utf8');
  for (const unitClass of ['scheduled', 'infrastructure']) {
    if (content === templates[unitClass].content) return {exists: true, class: unitClass};
  }
  throw new CloudMaintenanceGuardInstallError(`refusing unknown guard content: ${file}`);
}

async function inspectGuardPlan({systemdRoot, policies, templates}) {
  const rootExists = await assertRealDirectory(systemdRoot, {allowMissing: true});
  const policyByService = Object.fromEntries(policies.map(row => [row.service, row.class]));
  if (rootExists) {
    const entries = await fs.readdir(systemdRoot, {withFileTypes: true});
    for (const entry of entries) {
      const match = /^(shein-bi-[A-Za-z0-9_.@-]+\.service)\.d$/.exec(entry.name);
      if (!match) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new CloudMaintenanceGuardInstallError(`unsafe drop-in directory: ${path.join(systemdRoot, entry.name)}`);
      }
      const guard = path.join(systemdRoot, entry.name, '40-cloud-maintenance.conf');
      const guardStat = await lstatIfExists(guard);
      if (guardStat && !Object.hasOwn(policyByService, match[1])) {
        throw new CloudMaintenanceGuardInstallError(`guard exists for service without repository policy: ${guard}`);
      }
    }
  }

  const actions = [];
  const counts = {plannedInstall: 0, plannedReplace: 0, plannedRemove: 0, unchanged: 0};
  for (const row of policies) {
    const targetDir = path.join(systemdRoot, `${row.service}.d`);
    const targetDirStat = await lstatIfExists(targetDir);
    if (targetDirStat && (targetDirStat.isSymbolicLink() || !targetDirStat.isDirectory())) {
      throw new CloudMaintenanceGuardInstallError(`unsafe drop-in directory: ${targetDir}`);
    }
    const target = path.join(targetDir, '40-cloud-maintenance.conf');
    const existing = await inspectKnownGuard(target, templates);
    let action = 'unchanged';
    if (row.class === 'always') {
      if (existing.exists) action = 'remove';
    } else if (!existing.exists) {
      action = 'install';
    } else if (existing.class !== row.class) {
      action = 'replace';
    }
    if (action === 'unchanged') {
      counts.unchanged += 1;
    } else {
      const key = `planned${action[0].toUpperCase()}${action.slice(1)}`;
      counts[key] += 1;
    }
    actions.push({...row, targetDir, target, action});
  }
  return {actions, counts};
}

export async function auditCloudMaintenanceGuards({
  systemdRoot = process.env.SHEIN_BI_SYSTEMD_ROOT || '/etc/systemd/system',
  systemdSource = path.join(ROOT, 'infra', 'systemd'),
  systemctlBin = process.env.SHEIN_BI_SYSTEMCTL_BIN || 'systemctl',
} = {}) {
  const resolvedRoot = path.resolve(systemdRoot);
  const resolvedSource = path.resolve(systemdSource);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new CloudMaintenanceConfigurationError('unsafe maintenance guard systemd root');
  }
  const policies = await repositoryServicePolicies(resolvedSource);
  const templates = await readTrackedGuardTemplates(resolvedSource);
  const plan = await inspectGuardPlan({systemdRoot: resolvedRoot, policies, templates});
  const drift = plan.actions
    .filter(row => row.action !== 'unchanged')
    .map(row => ({service: row.service, class: row.class, action: row.action}));
  const effective = drift.length === 0
    ? await inspectEffectiveMaintenanceGuards({policies, systemctlBin})
    : {ok: false, checked: false, issues: []};
  return Object.freeze({
    ok: drift.length === 0 && plan.counts.unchanged === policies.length && effective.ok,
    policyCount: policies.length,
    ...plan.counts,
    effectiveChecked: effective.checked === true,
    issues: Object.freeze([...drift, ...(effective.issues || [])]),
  });
}

async function resolveExecutable(command) {
  const candidates = (path.isAbsolute(command) || command.includes(path.sep))
    ? [command]
    : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory()) return candidate;
    } catch {}
  }
  throw new CloudMaintenanceGuardInstallError(`systemctl command is unavailable: ${command}`);
}

function parseEffectiveGuardShow(stdout, policies) {
  const units = {};
  for (const block of String(stdout || '').trim().split(/\r?\n\s*\r?\n/u).filter(Boolean)) {
    const row = {};
    for (const line of block.split(/\r?\n/u)) {
      const index = line.indexOf('=');
      if (index > 0) row[line.slice(0, index)] = line.slice(index + 1);
    }
    const service = String(row.Id || '').trim();
    if (!service) continue;
    units[service] = {
      ...row,
      // systemd 255 omits an explicitly requested property when its effective
      // value is empty. Normalize that omission to the semantic empty value;
      // non-always services still fail below unless their exact non-empty
      // ExecCondition matches the reviewed maintenance policy.
      ExecCondition: String(row.ExecCondition || ''),
      complete: ['Id', 'LoadState'].every(property => Object.hasOwn(row, property)),
    };
  }
  for (const {service} of policies) {
    if (!units[service]) units[service] = {complete: false, LoadState: 'unknown', ExecCondition: ''};
  }
  return units;
}

async function inspectEffectiveMaintenanceGuards({policies, systemctlBin}) {
  const resolvedSystemctl = await resolveExecutable(systemctlBin);
  const services = policies.map(row => row.service);
  const result = spawnSync(resolvedSystemctl, [
    'show', ...services, '--no-pager', '--property=Id,LoadState,ExecCondition',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      checked: true,
      issues: [{
        kind: 'maintenance-guard',
        code: 'MAINTENANCE_GUARD_EFFECTIVE_QUERY_FAILED',
        status: result.status,
        errorCode: String(result.error?.code || ''),
        stderr: String(result.stderr || '').slice(0, 500),
      }],
    };
  }
  const validation = validateCloudMaintenanceEffectiveGuards(
    parseEffectiveGuardShow(result.stdout, policies),
    Object.fromEntries(policies.map(row => [row.service, row.class])),
  );
  return {...validation, checked: true};
}

async function applyGuardPlan({systemdRoot, policies, templates, systemctlBin}) {
  if (systemdRoot === '/etc/systemd/system' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw new CloudMaintenanceGuardInstallError('applying to /etc/systemd/system requires root');
  }
  const resolvedSystemctl = await resolveExecutable(systemctlBin);
  await fs.mkdir(systemdRoot, {recursive: true, mode: 0o755});
  await assertRealDirectory(systemdRoot);

  for (const row of policies) {
    const targetDir = path.join(systemdRoot, `${row.service}.d`);
    const target = path.join(targetDir, '40-cloud-maintenance.conf');
    const existing = await inspectKnownGuard(target, templates);
    if (row.class === 'always') {
      if (existing.exists) await fs.unlink(target);
      if (await lstatIfExists(target)) {
        throw new CloudMaintenanceGuardInstallError(`always service guard removal readback failed: ${target}`);
      }
      continue;
    }
    await fs.mkdir(targetDir, {recursive: true, mode: 0o755});
    await assertRealDirectory(targetDir);
    await writeFileAtomic(target, templates[row.class].content, {encoding: 'utf8', mode: 0o644});
    const readback = await inspectKnownGuard(target, templates);
    if (!readback.exists || readback.class !== row.class) {
      throw new CloudMaintenanceGuardInstallError(`guard publish readback mismatch: ${target}`);
    }
  }

  const finalPlan = await inspectGuardPlan({systemdRoot, policies, templates});
  if (finalPlan.actions.some(row => row.action !== 'unchanged')) {
    throw new CloudMaintenanceGuardInstallError('installed guard final readback mismatch', {
      actions: finalPlan.actions.filter(row => row.action !== 'unchanged'),
    });
  }
  const reload = spawnSync(resolvedSystemctl, ['daemon-reload'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (reload.error || reload.status !== 0) {
    throw new CloudMaintenanceGuardInstallError('systemctl daemon-reload failed', {
      status: reload.status,
      errorCode: String(reload.error?.code || ''),
      stderr: String(reload.stderr || '').slice(0, 500),
    });
  }
  const effective = await inspectEffectiveMaintenanceGuards({policies, systemctlBin: resolvedSystemctl});
  if (!effective.ok) {
    throw new CloudMaintenanceGuardInstallError('loaded maintenance guard effective readback mismatch', {
      issues: effective.issues,
    });
  }
}

async function runGuardInstaller(args, stdout) {
  const systemdSource = path.join(ROOT, 'infra', 'systemd');
  const policies = await repositoryServicePolicies(systemdSource);
  const templates = await readTrackedGuardTemplates(systemdSource);
  const plan = await inspectGuardPlan({systemdRoot: args.systemdRoot, policies, templates});
  if (!args.apply) {
    jsonLine(stdout, {
      ok: true,
      mode: 'audit',
      policyCount: policies.length,
      ...plan.counts,
      confirmation: GUARD_INSTALL_CONFIRMATION,
    });
    return 0;
  }
  await applyGuardPlan({
    systemdRoot: args.systemdRoot,
    policies,
    templates,
    systemctlBin: args.systemctlBin,
  });
  jsonLine(stdout, {
    ok: true,
    mode: 'apply',
    policyCount: policies.length,
    installed: plan.counts.plannedInstall,
    replaced: plan.counts.plannedReplace,
    removed: plan.counts.plannedRemove,
    unchanged: plan.counts.unchanged,
    daemonReload: true,
    effectiveGuardReadback: true,
  });
  return 0;
}

function jsonLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function publicStatus(command, status) {
  return {
    schemaVersion: status.schemaVersion,
    command,
    ok: status.ok,
    exists: status.exists,
    active: status.active,
    mode: status.mode,
    generation: status.generation,
    hash: status.hash,
    reason: status.reason,
    requestedBy: status.requestedBy,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    endedAt: status.endedAt,
    markerFile: status.markerFile,
    errorCode: status.errorCode,
    issues: status.issues,
  };
}

export async function runCloudMaintenanceCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const requestedCommand = String(argv[0] || '').trim().toLowerCase();
  try {
    const args = parseArgs(argv);
    if (args.command === 'install-guards') return await runGuardInstaller(args, stdout);
    if (args.command === 'policy') {
      const policies = await repositoryServicePolicies(args.systemdSource);
      if (args.format === 'tsv') {
        for (const row of policies) stdout.write(`${row.service}\t${row.class}\n`);
      } else if (args.format === 'json') {
        jsonLine(stdout, {ok: true, command: 'policy', policyCount: policies.length, policies});
      } else {
        throw new CloudMaintenanceConfigurationError('policy --format must be json or tsv');
      }
      return 0;
    }
    if (args.command === 'status') {
      const status = await readCloudMaintenanceStatus(args.markerFile);
      jsonLine(stdout, publicStatus('status', status));
      return status.ok ? 0 : CLOUD_MAINTENANCE_EXIT_CODES.configuration;
    }
    if (args.command === 'check' || args.command === 'systemd-condition') {
      const result = await checkCloudMaintenance({
        markerFile: args.markerFile,
        unitClass: args.unitClass,
        unit: args.unit,
      });
      const exitCode = args.command === 'systemd-condition'
        && result.exitCode === CLOUD_MAINTENANCE_EXIT_CODES.configuration
        ? CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration
        : result.exitCode;
      jsonLine(stdout, {...result, command: args.command, exitCode});
      return exitCode;
    }
    if (args.expectedGeneration === undefined || !args.expectedHash) {
      throw new CloudMaintenanceConfigurationError('pause/resume require --expected-generation and --expected-hash from status');
    }
    const common = {
      markerFile: args.markerFile,
      reason: args.reason,
      requestedBy: args.requestedBy,
      expectedGeneration: args.expectedGeneration,
      expectedHash: args.expectedHash,
    };
    if (args.command === 'pause') {
      const guardAudit = await auditCloudMaintenanceGuards({
        systemdRoot: args.systemdRoot,
        systemctlBin: args.systemctlBin,
      });
      if (!guardAudit.ok) {
        throw new CloudMaintenanceGuardInstallError('maintenance pause refused because guard installation is not fully settled', {
          policyCount: guardAudit.policyCount,
          issues: guardAudit.issues,
        });
      }
    }
    const status = args.command === 'pause'
      ? await pauseCloudMaintenance({...common, mode: args.mode})
      : await resumeCloudMaintenance(common);
    jsonLine(stdout, publicStatus(args.command, status));
    return 0;
  } catch (error) {
    let exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    if (requestedCommand === 'systemd-condition'
      && exitCode === CLOUD_MAINTENANCE_EXIT_CODES.configuration) {
      exitCode = CLOUD_MAINTENANCE_EXIT_CODES.systemdConfiguration;
    }
    jsonLine(stderr, {
      ok: false,
      exitCode,
      errorCode: String(error?.code || 'CLOUD_MAINTENANCE_OPERATION_FAILED'),
      error: String(error?.message || error),
      detail: error?.detail || {},
    });
    return exitCode;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runCloudMaintenanceCli(process.argv.slice(2));
