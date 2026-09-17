// Single source of truth for the production cloud host that local entrypoints
// reach over SSH.
//
// The semi-managed migration moved production from shein-bi-tencent to
// shein-bi-fnos on 2026-09-15. An entrypoint that hardcodes one alias is a
// latent production outage: the retire-link review and its delivery channel
// kept ssh-ing to a stopped host, so the formal entrypoint silently degraded
// into an offline approximation. Resolve the host once, in this order:
// explicit --cloud-ssh argument, environment override, built-in default.
export const PRODUCTION_CLOUD_HOST_DEFAULT = 'shein-bi-fnos';
export const PRODUCTION_CLOUD_APP_ROOT_DEFAULT = '/opt/shein-bi/app';
export const PRODUCTION_CLOUD_HOST_ENV_KEYS = Object.freeze([
  'SHEIN_BI_PRODUCTION_CLOUD_HOST',
  'CLOUD_TEAM_REPORT_SSH_HOST',
]);
const CLOUD_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function assertSafeCloudHost(host, label = 'cloud host') {
  const value = String(host ?? '').trim();
  if (!CLOUD_HOST_RE.test(value)) {
    throw new Error(`${label} must be a plain ssh host alias; got=${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveProductionCloudHost({explicit = '', env = process.env} = {}) {
  const declared = String(explicit ?? '').trim();
  if (declared) return assertSafeCloudHost(declared, '--cloud-ssh');
  for (const key of PRODUCTION_CLOUD_HOST_ENV_KEYS) {
    const value = String(env?.[key] ?? '').trim();
    if (value) return assertSafeCloudHost(value, key);
  }
  return PRODUCTION_CLOUD_HOST_DEFAULT;
}

export function resolveProductionCloudAppRoot({explicit = ''} = {}) {
  const declared = String(explicit ?? '').trim();
  return declared || PRODUCTION_CLOUD_APP_ROOT_DEFAULT;
}

// The former cloud host. Kept only so a guard can name it in an explanation;
// it must never be selected as a writable or readable production target.
export const RETIRED_CLOUD_HOST = 'shein-bi-tencent';

