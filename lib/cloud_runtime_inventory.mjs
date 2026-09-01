export const CLOUD_MAINTENANCE_CLASSES = Object.freeze([
  'scheduled',
  'infrastructure',
  'always',
]);

export const CLOUD_SERVICE_UNITS = Object.freeze([
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
  'shein-bi-query.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
  'shein-bi-cloud-daily-refresh.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-openapi-stock-refresh.service',
  'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-manual-login-recovery.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-cloud-disk-maintenance.service',
]);

// These are daemons, not merely services whose maintenance policy is
// "always". The watchdog service is an hourly oneshot and therefore must not
// be treated as continuously active even though maintenance never blocks it.
export const CLOUD_ALWAYS_RUNNING_UNITS = Object.freeze([
  'shein-bi-portal.service',
  'shein-bi-webhook.service',
  'shein-bi-query.service',
]);

export const INVENTORY_WRITER_COMPATIBILITY_GUARD_PATH = '/usr/local/libexec/shein-bi-inventory-writer-compatibility-guard';
export const INVENTORY_WRITER_COMPATIBILITY_CONTROL_DIR = '/var/lib/shein-bi-control/inventory-writer-compatibility';
export const INVENTORY_WRITER_COMPATIBILITY_SERVICES = Object.freeze([
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
]);

export function expectedInventoryWriterCompatibilityCommand(service) {
  return `${INVENTORY_WRITER_COMPATIBILITY_GUARD_PATH} --unit ${service} --systemctl-bin /usr/bin/systemctl --app-root /opt/shein-bi/app --activation-file ${INVENTORY_WRITER_COMPATIBILITY_CONTROL_DIR}/activation.ndjson --activation-receipt-file ${INVENTORY_WRITER_COMPATIBILITY_CONTROL_DIR}/activation.receipt.json --compatibility-file ${INVENTORY_WRITER_COMPATIBILITY_CONTROL_DIR}/compatibility.ndjson --compatibility-receipt-file ${INVENTORY_WRITER_COMPATIBILITY_CONTROL_DIR}/compatibility.receipt.json`;
}

export function parseSystemdExecCommands(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  const structured = [...raw.matchAll(/(?:^|[;{\s])argv\[\]=([^;}]*?)(?=\s*;|\s*\})/g)]
    .map(match => String(match[1] || '').trim()).filter(Boolean);
  return structured.length ? structured : [raw];
}

export function validateInventoryWriterCompatibilityEffectiveGuards(units = {}) {
  const issues = [];
  for (const service of INVENTORY_WRITER_COMPATIBILITY_SERVICES) {
    const expected = expectedInventoryWriterCompatibilityCommand(service);
    const unit = units?.[service] || {};
    const commands = parseSystemdExecCommands(unit.ExecStartPre);
    const matched = commands.filter(command => command === expected);
    if (unit.complete !== true || unit.LoadState !== 'loaded' || matched.length !== 1 || commands.at(-1) !== expected) {
      issues.push({kind: 'inventory-writer-guard', service, code: 'INVENTORY_WRITER_COMPATIBILITY_GUARD_EFFECTIVE_MISMATCH', expected, actualCommands: commands});
    }
  }
  return Object.freeze({ok: issues.length === 0, checkedServiceCount: INVENTORY_WRITER_COMPATIBILITY_SERVICES.length, issues: Object.freeze(issues)});
}

export const CLOUD_TIMER_SERVICE_BY_TIMER = Object.freeze({
  'shein-bi-cloud-yesterday.timer': 'shein-bi-cloud-yesterday.service',
  'shein-bi-db-backup.timer': 'shein-bi-db-backup.service',
  'shein-bi-cloud-et-forwarder.timer': 'shein-bi-cloud-et-forwarder.service',
  'shein-bi-et-low-inventory-recheck.timer': 'shein-bi-et-low-inventory-recheck.service',
  'shein-bi-cloud-morning-chain.timer': 'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-session-manager.timer': 'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-openapi-stock-refresh.timer': 'shein-bi-cloud-openapi-stock-refresh.service',
  'shein-bi-cloud-today-sales-reconcile.timer': 'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-manual-login-recovery.timer': 'shein-bi-cloud-manual-login-recovery.service',
  'shein-bi-cloud-rtv-verify.timer': 'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-order-closure.timer': 'shein-bi-cloud-order-closure.service',
  'shein-bi-cloud-portal-section-queue.timer': 'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-et-storage-fee.timer': 'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-cloud-marketing-live-guard.timer': 'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.timer': 'shein-bi-cloud-marketing-repair.service',
  'shein-bi-cloud-browser-cleanup.timer': 'shein-bi-cloud-browser-cleanup.service',
  'shein-bi-cloud-disk-maintenance.timer': 'shein-bi-cloud-disk-maintenance.service',
  'shein-bi-cloud-watchdog.timer': 'shein-bi-cloud-watchdog.service',
});

export const CLOUD_TIMER_UNITS = Object.freeze(Object.keys(CLOUD_TIMER_SERVICE_BY_TIMER));

export const CLOUD_AUXILIARY_UNITS = Object.freeze([
  'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.service',
]);

// CLOUD_MAINTENANCE_POLICY_ROWS_BEGIN
export const CLOUD_MAINTENANCE_POLICY_ROWS = Object.freeze([
  "shein-bi-cloud-browser-cleanup.service\tscheduled",
  "shein-bi-cloud-daily-lark-report.service\tscheduled",
  "shein-bi-cloud-daily-refresh.service\tscheduled",
  "shein-bi-cloud-disk-maintenance.service\tinfrastructure",
  "shein-bi-cloud-et-forwarder.service\tscheduled",
  "shein-bi-cloud-et-storage-fee.service\tscheduled",
  "shein-bi-cloud-manual-login-recovery.service\tscheduled",
  "shein-bi-cloud-marketing-live-guard.service\tscheduled",
  "shein-bi-cloud-marketing-repair.service\tscheduled",
  "shein-bi-cloud-morning-chain.service\tscheduled",
  "shein-bi-cloud-openapi-stock-refresh.service\tscheduled",
  "shein-bi-cloud-order-closure.service\tscheduled",
  "shein-bi-cloud-portal-section-queue.service\tinfrastructure",
  "shein-bi-cloud-rtv-verify.service\tscheduled",
  "shein-bi-cloud-session-manager.service\tscheduled",
  "shein-bi-cloud-today-sales-reconcile.service\tscheduled",
  "shein-bi-cloud-today.service\tscheduled",
  "shein-bi-cloud-watchdog.service\talways",
  "shein-bi-cloud-yesterday.service\tscheduled",
  "shein-bi-daily-inventory-replenishment-guard.service\tscheduled",
  "shein-bi-db-backup.service\tinfrastructure",
  "shein-bi-et-low-inventory-guard.service\tscheduled",
  "shein-bi-et-low-inventory-recheck.service\tscheduled",
  "shein-bi-lark-sales-qa.service\tscheduled",
  "shein-bi-portal.service\talways",
  "shein-bi-query.service\talways",
  "shein-bi-session-secret.service\talways",
  "shein-bi-webhook.service\talways",
]);
// CLOUD_MAINTENANCE_POLICY_ROWS_END

const maintenancePolicyEntries = CLOUD_MAINTENANCE_POLICY_ROWS.map(row => row.split('\t'));

export const CLOUD_EXPECTED_SERVICE_UNITS = Object.freeze(
  maintenancePolicyEntries.map(([service]) => service),
);

export const CLOUD_MAINTENANCE_POLICY_BY_SERVICE = Object.freeze(
  Object.fromEntries(maintenancePolicyEntries),
);

const CLOUD_MAINTENANCE_CONDITION_SCRIPT = '/opt/shein-bi/app/scripts/manage_cloud_maintenance_mode.mjs';

export function expectedCloudMaintenanceExecCondition(service, unitClass, unitArgument = service) {
  return `/usr/bin/node ${CLOUD_MAINTENANCE_CONDITION_SCRIPT} systemd-condition --class ${unitClass} --unit ${unitArgument}`;
}

export function parseSystemdExecConditionCommands(value) {
  return parseSystemdExecCommands(value);
}

export function validateCloudMaintenanceEffectiveGuards(
  units = {},
  policyByService = CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
) {
  const issues = [];
  for (const [service, unitClass] of Object.entries(policyByService || {})) {
    const unit = units?.[service] || {};
    if (unit.complete !== true || unit.LoadState !== 'loaded') {
      issues.push({
        kind: 'maintenance-guard', service,
        code: 'MAINTENANCE_GUARD_EFFECTIVE_PROPERTIES_UNAVAILABLE',
        loadState: String(unit.LoadState || 'unknown'),
      });
      continue;
    }
    const commands = parseSystemdExecConditionCommands(unit.ExecCondition);
    const accepted = unitClass === 'always'
      ? commands.length === 0
      : commands.length === 1 && new Set([
        expectedCloudMaintenanceExecCondition(service, unitClass, service),
        expectedCloudMaintenanceExecCondition(service, unitClass, '%n'),
      ]).has(commands[0]);
    if (!accepted) {
      issues.push({
        kind: 'maintenance-guard', service,
        code: unitClass === 'always'
          ? 'ALWAYS_SERVICE_HAS_MAINTENANCE_GUARD'
          : 'MAINTENANCE_GUARD_EFFECTIVE_PROPERTY_MISMATCH',
        expectedClass: unitClass,
        expectedCommandCount: unitClass === 'always' ? 0 : 1,
        actualCommands: commands,
      });
    }
  }
  return Object.freeze({
    ok: issues.length === 0,
    checkedServiceCount: Object.keys(policyByService || {}).length,
    issues: Object.freeze(issues),
  });
}

export const CLOUD_TIMER_MAINTENANCE_POLICY = Object.freeze(Object.fromEntries(
  Object.entries(CLOUD_TIMER_SERVICE_BY_TIMER)
    .map(([timer, service]) => [timer, CLOUD_MAINTENANCE_POLICY_BY_SERVICE[service]]),
));

export const CLOUD_RUNTIME_UNITS = Object.freeze([
  ...new Set([...CLOUD_SERVICE_UNITS, ...CLOUD_TIMER_UNITS, ...CLOUD_AUXILIARY_UNITS]),
]);

// Read-only acceptance/watchdog snapshots cover every tracked service policy,
// including intentionally disabled diagnostic entry points, plus every timer.
// Runtime-health loops may still use the smaller CLOUD_RUNTIME_UNITS set.
export const CLOUD_RUNTIME_SNAPSHOT_UNITS = Object.freeze([
  ...new Set([...CLOUD_EXPECTED_SERVICE_UNITS, ...CLOUD_TIMER_UNITS]),
]);

// Deployment copies every tracked shein-bi service/timer/path into systemd,
// including intentionally disabled manual or diagnostic entry points. Keep
// installation presence separate from the smaller runtime-health inventory.
export const CLOUD_EXPECTED_INSTALLED_UNITS = Object.freeze([
  ...new Set([
    ...CLOUD_EXPECTED_SERVICE_UNITS,
    ...CLOUD_TIMER_UNITS,
    'shein-bi-cloud-manual-login-recovery.path',
  ]),
]);

export const CLOUD_LEGACY_MASKED_UNIT_ALLOWLIST = Object.freeze([
  'shein-bi-cloud-link-business.service',
  'shein-bi-cloud-link-business.timer',
  'shein-bi-cloud-openapi-hl.service',
  'shein-bi-cloud-openapi-hl.timer',
]);

function contractEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

export function validateCloudServicePolicyContract(
  repositoryServices,
  policyByService = CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
) {
  const issues = [];
  const validClasses = new Set(CLOUD_MAINTENANCE_CLASSES);
  const repositoryEntries = Array.isArray(repositoryServices) ? repositoryServices : [];
  const repositorySet = new Set();
  for (const rawService of repositoryEntries) {
    const service = String(rawService || '').trim();
    if (!service || !service.endsWith('.service')) {
      issues.push({code: 'SERVICE_POLICY_NAME_INVALID', service});
      continue;
    }
    if (repositorySet.has(service)) {
      issues.push({code: 'SERVICE_POLICY_REPOSITORY_DUPLICATE', service});
      continue;
    }
    repositorySet.add(service);
    const rawPolicy = policyByService?.[service];
    const policies = Array.isArray(rawPolicy) ? rawPolicy : [rawPolicy];
    if (policies.length !== 1 || !validClasses.has(policies[0])) {
      issues.push({code: 'SERVICE_POLICY_NOT_UNIQUE', service, policies});
    }
  }
  for (const [service, unitClass] of Object.entries(policyByService || {})) {
    if (!repositorySet.has(service)) {
      issues.push({code: 'SERVICE_POLICY_UNEXPECTED', service, unitClass});
    }
  }
  return {
    ok: issues.length === 0,
    repositoryServiceCount: repositorySet.size,
    policyServiceCount: Object.keys(policyByService || {}).length,
    issues,
  };
}

export function validateCloudTimerPolicyContract(
  repositoryTimerToService,
  registeredTimerToService = CLOUD_TIMER_SERVICE_BY_TIMER,
  policyByService = CLOUD_MAINTENANCE_POLICY_BY_SERVICE,
) {
  const issues = [];
  const repositoryEntries = contractEntries(repositoryTimerToService);
  const registeredEntries = contractEntries(registeredTimerToService);
  const registered = new Map(registeredEntries);
  const repositoryTimers = new Set();
  const validClasses = new Set(CLOUD_MAINTENANCE_CLASSES);

  for (const [rawTimer, rawService] of repositoryEntries) {
    const timer = String(rawTimer || '').trim();
    const service = String(rawService || '').trim();
    if (!timer || !service) {
      issues.push({code: 'TIMER_CONTRACT_ENTRY_INVALID', timer, service});
      continue;
    }
    if (repositoryTimers.has(timer)) {
      issues.push({code: 'TIMER_CONTRACT_DUPLICATE', timer});
      continue;
    }
    repositoryTimers.add(timer);
    if (!registered.has(timer)) {
      issues.push({code: 'TIMER_POLICY_REGISTRATION_MISSING', timer, service});
      continue;
    }
    if (registered.get(timer) !== service) {
      issues.push({
        code: 'TIMER_SERVICE_TARGET_MISMATCH',
        timer,
        expectedService: service,
        registeredService: registered.get(timer),
      });
      continue;
    }
    const rawPolicy = policyByService?.[service];
    const policies = Array.isArray(rawPolicy) ? rawPolicy : [rawPolicy];
    if (policies.length !== 1 || !validClasses.has(policies[0])) {
      issues.push({code: 'TIMER_SERVICE_POLICY_NOT_UNIQUE', timer, service, policies});
    }
  }

  for (const [timer, service] of registeredEntries) {
    if (!repositoryTimers.has(timer)) {
      issues.push({code: 'TIMER_POLICY_REGISTRATION_UNEXPECTED', timer, service});
    }
  }

  return {
    ok: issues.length === 0,
    timerCount: repositoryTimers.size,
    registeredTimerCount: registered.size,
    policyServiceCount: Object.keys(policyByService || {}).length,
    issues,
  };
}
