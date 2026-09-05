import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Persist logical identities in plans. Resolve only the physical read/write
// location; changing a service mount namespace must not change a queue hash.
export function runtimeArtifactLocation({root, file, env = process.env}) {
  const sourceRoot = path.resolve(root);
  const productionRoot = sourceRoot.replaceAll('\\', '/') === '/opt/shein-bi/app';
  const domains = Object.fromEntries(['outputs', 'state'].map(domain => [domain,
    path.resolve(env[`SHEIN_BI_${domain.toUpperCase()}_ROOT`]
      || (productionRoot ? `/data/shein-bi/${domain}` : path.join(sourceRoot, domain))),
  ]));
  const raw = String(file || '');
  if (!raw || raw !== raw.trim() || /[\r\n\0]/.test(raw)) throw new Error('Invalid runtime artifact path');
  const baselinePrefix = '../../../srv/shein-bi/runtime/marketing-plans/';
  const slashRaw = raw.replaceAll('\\', '/');
  const baselineSuffix = slashRaw.startsWith(baselinePrefix) ? slashRaw.slice(baselinePrefix.length)
    : slashRaw.startsWith('/srv/shein-bi/runtime/marketing-plans/') ? slashRaw.slice('/srv/shein-bi/runtime/marketing-plans/'.length) : '';
  if (baselineSuffix) {
    if (baselineSuffix.split('/').includes('..') || !baselineSuffix.endsWith('.json')) throw new Error('Invalid marketing baseline artifact');
    const physicalRoot = path.resolve(env.SHEIN_BI_MARKETING_PLAN_ROOT
      || (productionRoot ? '/srv/shein-bi/runtime/marketing-plans' : path.resolve(sourceRoot, baselinePrefix)));
    const physicalPath = path.resolve(physicalRoot, baselineSuffix);
    return {logicalPath: `${baselinePrefix}${baselineSuffix}`, portablePath: `runtime/marketing-plans/${baselineSuffix}`,
      path: physicalPath, sourcePath: physicalPath, physicalRoot};
  }
  let logicalPath = raw.replaceAll('\\', '/');
  if (path.isAbsolute(raw)) {
    const mapped = Object.entries(domains).find(([, base]) => {
      const relative = path.relative(base, raw);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    logicalPath = mapped
      ? `${mapped[0]}/${path.relative(mapped[1], raw).replaceAll(path.sep, '/')}`
      : path.relative(sourceRoot, raw).replaceAll(path.sep, '/');
  }
  if (logicalPath.split('/').includes('..') || logicalPath.startsWith('/') || /^[A-Za-z]:/.test(logicalPath)) {
    throw new Error(`Runtime artifact escapes its logical root: ${raw}`);
  }
  logicalPath = path.posix.normalize(logicalPath);
  if (!logicalPath || logicalPath === '.') throw new Error('Runtime artifact must name a file');
  const [domain, ...rest] = logicalPath.split('/');
  const physicalRoot = domains[domain] || sourceRoot;
  const physicalPath = domains[domain] ? path.resolve(physicalRoot, ...rest) : path.resolve(sourceRoot, logicalPath);
  return {logicalPath, portablePath: logicalPath, path: physicalPath, sourcePath: path.resolve(sourceRoot, logicalPath), physicalRoot};
}

export async function readCloudRuntimeArtifact(options) {
  const location = runtimeArtifactLocation(options);
  async function readRegular(file, base) {
    let stat;
    try { stat = await fs.lstat(file); }
    catch (error) { throw Object.assign(new Error(`Artifact unavailable: ${location.logicalPath} (${file}): ${error.code}`), {code: error.code}); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Artifact must be a regular file: ${location.logicalPath}`);
    const [actual, boundary] = await Promise.all([fs.realpath(file), fs.realpath(base)]);
    const relative = path.relative(boundary, actual);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Artifact resolves outside its data root: ${location.logicalPath}`);
    return fs.readFile(file);
  }
  const bytes = await readRegular(location.path, location.physicalRoot);
  if (location.path !== location.sourcePath) {
    let legacy;
    try { legacy = await readRegular(location.sourcePath, path.resolve(options.root)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacy && !bytes.equals(legacy)) throw new Error(`Artifact namespace conflict: ${location.logicalPath}; canonical and source view bytes differ`);
  }
  return {...location, bytes, sizeBytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}

export const CLOUD_RUNTIME_CANONICAL_PATHS = Object.freeze({
  profiles: '/data/shein-bi/profiles',
  state: '/data/shein-bi/state',
  outputs: '/data/shein-bi/outputs',
});

export const CLOUD_RUNTIME_HOST_PATHS = Object.freeze({
  profiles: '/opt/shein-bi/app/profiles',
  state: '/opt/shein-bi/app/state',
  outputs: '/opt/shein-bi/app/outputs',
});

const policy = (profiles, state, outputs) => Object.freeze({profiles, state, outputs});
const pathExtras = ({readOnlyPaths = [], inaccessiblePaths = []} = {}) => Object.freeze({
  readOnlyPaths: Object.freeze([...readOnlyPaths]),
  inaccessiblePaths: Object.freeze([...inaccessiblePaths]),
});

// These paths are owned by the tracked base units rather than by the generated
// runtime-layout drop-in. They still form part of the authoritative effective
// namespace returned by `systemctl show`, so snapshot/migration verification
// must require them. Keeping them out of the drop-in preserves the ownership
// boundary: the installer manages only profiles/state/outputs, while the base
// units retain their service-specific source/secrets hardening.
export const CLOUD_RUNTIME_EFFECTIVE_PATH_EXTRAS_BY_SERVICE = Object.freeze({
  'shein-bi-query.service': pathExtras({
    readOnlyPaths: ['/opt/shein-bi/app', '/srv/shein-bi/secrets', '/srv/shein-bi/partner-cli'],
  }),
  'shein-bi-session-secret.service': pathExtras({
    readOnlyPaths: ['/opt/shein-bi/app'],
    inaccessiblePaths: ['/srv/shein-bi/secrets'],
  }),
});

// Every tracked shein-bi service is intentionally listed. There is no fallback:
// adding a service must also add a reviewed path policy before installation can
// proceed. Profile RW is limited to services whose current ExecStart chain can
// launch Chrome/ET, maintain profile files, or clean profile-owned artifacts.
//
// Two-sided read-only contract: a bind (even a read-only bind) only changes what
// the service sees at the *target* path. The canonical source at /data/shein-bi
// remains directly reachable and writable unless it is separately protected, so
// every non-writable policy protects both sides:
//   - profiles host-ro  -> BindReadOnlyPaths canonical:legacy AND
//                          ReadOnlyPaths=<canonical profiles>
//   - state/outputs ro  -> BindReadOnlyPaths canonical:legacy AND
//                          ReadOnlyPaths=<canonical state/outputs>
//   - profiles none     -> InaccessiblePaths=<canonical profiles> <legacy profiles>
// host-ro is still an explicit unit-private read-only bind; it does not rely on
// the host-level app/profiles bind being present before the service starts.
// A service with no browser responsibility uses `none`, which hides both the
// canonical and legacy app paths instead of exposing credential-bearing files.
export const CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE = Object.freeze({
  'shein-bi-cloud-browser-cleanup.service': policy('rw', 'rw', 'ro'),
  'shein-bi-cloud-daily-lark-report.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-daily-refresh.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-disk-maintenance.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-et-forwarder.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-et-storage-fee.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-manual-login-recovery.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-marketing-live-guard.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-marketing-repair.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-morning-chain.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-openapi-stock-refresh.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-order-closure.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-portal-section-queue.service': policy('host-ro', 'rw', 'ro'),
  'shein-bi-cloud-rtv-verify.service': policy('host-ro', 'rw', 'ro'),
  'shein-bi-cloud-session-manager.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-today-sales-reconcile.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-today.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-cloud-watchdog.service': policy('rw', 'rw', 'rw'),
  'shein-bi-cloud-yesterday.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-daily-inventory-replenishment-guard.service': policy('host-ro', 'rw', 'rw'),
  'shein-bi-db-backup.service': policy('host-ro', 'rw', 'ro'),
  'shein-bi-et-low-inventory-guard.service': policy('host-ro', 'rw', 'ro'),
  'shein-bi-et-low-inventory-recheck.service': policy('rw', 'rw', 'rw'),
  'shein-bi-lark-sales-qa.service': policy('host-ro', 'rw', 'ro'),
  'shein-bi-portal.service': policy('rw', 'rw', 'rw'),
  'shein-bi-query.service': policy('none', 'ro', 'ro'),
  'shein-bi-session-secret.service': policy('none', 'rw', 'ro'),
  'shein-bi-webhook.service': policy('none', 'ro', 'ro'),
});

const SERVICE_NAME = /^shein-bi-[A-Za-z0-9_.@-]+\.service$/;
const VALID_PROFILES = new Set(['none', 'host-ro', 'rw']);
const VALID_ACCESS = new Set(['ro', 'rw']);

export async function discoverCloudRuntimeServices(systemdSourceDir) {
  const entries = await fs.readdir(systemdSourceDir, {withFileTypes: true});
  const matching = entries.filter(entry => SERVICE_NAME.test(entry.name));
  const unsafe = matching.filter(entry => !entry.isFile()).map(entry => entry.name).sort();
  if (unsafe.length) throw new Error(`runtime service sources must be regular files: ${unsafe.join(',')}`);
  return matching.map(entry => entry.name).sort();
}

export function validateCloudRuntimePathPolicy(
  repositoryServices,
  policyByService = CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE,
) {
  const services = Array.isArray(repositoryServices) ? repositoryServices : [];
  const issues = [];
  const seen = new Set();
  for (const rawService of services) {
    const service = String(rawService || '').trim();
    if (!SERVICE_NAME.test(service)) {
      issues.push({code: 'RUNTIME_PATH_SERVICE_NAME_INVALID', service});
      continue;
    }
    if (seen.has(service)) {
      issues.push({code: 'RUNTIME_PATH_SERVICE_DUPLICATE', service});
      continue;
    }
    seen.add(service);
    const value = policyByService?.[service];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({code: 'RUNTIME_PATH_POLICY_MISSING', service});
      continue;
    }
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== 'outputs,profiles,state') {
      issues.push({code: 'RUNTIME_PATH_POLICY_KEYS_INVALID', service, keys});
    }
    if (!VALID_PROFILES.has(value.profiles)) {
      issues.push({code: 'RUNTIME_PATH_PROFILES_POLICY_INVALID', service, value: value.profiles});
    }
    if (!VALID_ACCESS.has(value.state)) {
      issues.push({code: 'RUNTIME_PATH_STATE_POLICY_INVALID', service, value: value.state});
    }
    if (!VALID_ACCESS.has(value.outputs)) {
      issues.push({code: 'RUNTIME_PATH_OUTPUTS_POLICY_INVALID', service, value: value.outputs});
    }
  }
  for (const service of Object.keys(policyByService || {})) {
    if (!seen.has(service)) issues.push({code: 'RUNTIME_PATH_POLICY_UNEXPECTED', service});
  }
  return Object.freeze({
    ok: issues.length === 0 && seen.size > 0,
    repositoryServiceCount: seen.size,
    policyServiceCount: Object.keys(policyByService || {}).length,
    issues: Object.freeze(issues),
  });
}

export function renderCloudRuntimePathDropIn(service, value) {
  if (!SERVICE_NAME.test(String(service || ''))) throw new Error(`invalid service name: ${service}`);
  const validation = validateCloudRuntimePathPolicy([service], {[service]: value});
  if (!validation.ok) throw new Error(`invalid runtime path policy: ${JSON.stringify(validation.issues)}`);

  const directives = cloudRuntimePathDropInDirectives(service, value);
  const lines = [
    '[Unit]',
    `RequiresMountsFor=${directives.requiresMountsFor.join(' ')}`,
    '',
    '[Service]',
    ...(directives.inaccessiblePaths.length ? [`InaccessiblePaths=${directives.inaccessiblePaths.join(' ')}`] : []),
    ...directives.bindPaths.map(binding => `BindPaths=${binding}`),
    ...directives.bindReadOnlyPaths.map(binding => `BindReadOnlyPaths=${binding}`),
    ...(directives.readOnlyPaths.length ? [`ReadOnlyPaths=${directives.readOnlyPaths.join(' ')}`] : []),
    '',
  ];
  return lines.join('\n');
}

export function cloudRuntimePathDropInDirectives(service, value) {
  if (!SERVICE_NAME.test(String(service || ''))) throw new Error(`invalid service name: ${service}`);
  const validation = validateCloudRuntimePathPolicy([service], {[service]: value});
  if (!validation.ok) throw new Error(`invalid runtime path policy: ${JSON.stringify(validation.issues)}`);

  const rw = [];
  const ro = [];
  const readOnly = [];
  const inaccessible = [];
  if (value.profiles === 'rw') {
    rw.push(`${CLOUD_RUNTIME_CANONICAL_PATHS.profiles}:${CLOUD_RUNTIME_HOST_PATHS.profiles}`);
  } else if (value.profiles === 'host-ro') {
    ro.push(`${CLOUD_RUNTIME_CANONICAL_PATHS.profiles}:${CLOUD_RUNTIME_HOST_PATHS.profiles}`);
    // BindReadOnlyPaths above only makes the legacy target read-only; the
    // canonical /data/shein-bi/profiles stays writable unless it is separately
    // marked read-only, which is exactly the source/target gap this closes.
    readOnly.push(CLOUD_RUNTIME_CANONICAL_PATHS.profiles);
  } else {
    inaccessible.push(CLOUD_RUNTIME_CANONICAL_PATHS.profiles, CLOUD_RUNTIME_HOST_PATHS.profiles);
  }
  for (const domain of ['state', 'outputs']) {
    const binding = `${CLOUD_RUNTIME_CANONICAL_PATHS[domain]}:${CLOUD_RUNTIME_HOST_PATHS[domain]}`;
    if (value[domain] === 'rw') {
      rw.push(binding);
    } else {
      ro.push(binding);
      // Same two-sided rule: the bind only protects the /opt legacy target, so
      // the canonical source must also enter ReadOnlyPaths to be non-writable.
      readOnly.push(CLOUD_RUNTIME_CANONICAL_PATHS[domain]);
    }
  }
  return Object.freeze({
    requiresMountsFor: Object.freeze(Object.values(CLOUD_RUNTIME_CANONICAL_PATHS)),
    bindPaths: Object.freeze(rw),
    bindReadOnlyPaths: Object.freeze(ro),
    readOnlyPaths: Object.freeze(readOnly),
    inaccessiblePaths: Object.freeze(inaccessible),
  });
}

export function cloudRuntimePathEffectiveDirectives(service, value) {
  const directives = cloudRuntimePathDropInDirectives(service, value);
  const extras = CLOUD_RUNTIME_EFFECTIVE_PATH_EXTRAS_BY_SERVICE[service] || pathExtras();
  return Object.freeze({
    requiresMountsFor: directives.requiresMountsFor,
    bindPaths: directives.bindPaths,
    bindReadOnlyPaths: directives.bindReadOnlyPaths,
    readOnlyPaths: Object.freeze([...new Set([
      ...directives.readOnlyPaths,
      ...extras.readOnlyPaths,
    ])]),
    inaccessiblePaths: Object.freeze([...new Set([
      ...directives.inaccessiblePaths,
      ...extras.inaccessiblePaths,
    ])]),
  });
}
