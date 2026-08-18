#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  CLOUD_RUNTIME_EFFECTIVE_PATH_EXTRAS_BY_SERVICE,
  CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE,
  cloudRuntimePathDropInDirectives,
  cloudRuntimePathEffectiveDirectives,
  discoverCloudRuntimeServices,
  renderCloudRuntimePathDropIn,
  validateCloudRuntimePathPolicy,
} from '../lib/cloud_runtime_path_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = await discoverCloudRuntimeServices(path.join(ROOT, 'infra', 'systemd'));
const expected = [
  'shein-bi-cloud-browser-cleanup.service',
  'shein-bi-cloud-daily-lark-report.service',
  'shein-bi-cloud-daily-refresh.service',
  'shein-bi-cloud-disk-maintenance.service',
  'shein-bi-cloud-et-forwarder.service',
  'shein-bi-cloud-et-storage-fee.service',
  'shein-bi-cloud-manual-login-recovery.service',
  'shein-bi-cloud-marketing-live-guard.service',
  'shein-bi-cloud-marketing-repair.service',
  'shein-bi-cloud-morning-chain.service',
  'shein-bi-cloud-openapi-stock-refresh.service',
  'shein-bi-cloud-order-closure.service',
  'shein-bi-cloud-portal-section-queue.service',
  'shein-bi-cloud-rtv-verify.service',
  'shein-bi-cloud-session-manager.service',
  'shein-bi-cloud-today-sales-reconcile.service',
  'shein-bi-cloud-today.service',
  'shein-bi-cloud-watchdog.service',
  'shein-bi-cloud-yesterday.service',
  'shein-bi-daily-inventory-replenishment-guard.service',
  'shein-bi-db-backup.service',
  'shein-bi-et-low-inventory-guard.service',
  'shein-bi-et-low-inventory-recheck.service',
  'shein-bi-lark-sales-qa.service',
  'shein-bi-portal.service',
  'shein-bi-query.service',
  'shein-bi-session-secret.service',
  'shein-bi-webhook.service',
];
assert.deepEqual(services, expected);
assert.deepEqual(Object.keys(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE).sort(), expected);
assert.deepEqual(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE, {
  'shein-bi-cloud-browser-cleanup.service': {profiles: 'rw', state: 'rw', outputs: 'ro'},
  'shein-bi-cloud-daily-lark-report.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-daily-refresh.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-disk-maintenance.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-et-forwarder.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-et-storage-fee.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-manual-login-recovery.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-marketing-live-guard.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-marketing-repair.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-morning-chain.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-openapi-stock-refresh.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-order-closure.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-portal-section-queue.service': {profiles: 'host-ro', state: 'rw', outputs: 'ro'},
  'shein-bi-cloud-rtv-verify.service': {profiles: 'host-ro', state: 'rw', outputs: 'ro'},
  'shein-bi-cloud-session-manager.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-today-sales-reconcile.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-today.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-watchdog.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-cloud-yesterday.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-daily-inventory-replenishment-guard.service': {profiles: 'host-ro', state: 'rw', outputs: 'rw'},
  'shein-bi-db-backup.service': {profiles: 'host-ro', state: 'rw', outputs: 'ro'},
  'shein-bi-et-low-inventory-guard.service': {profiles: 'host-ro', state: 'rw', outputs: 'ro'},
  'shein-bi-et-low-inventory-recheck.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-lark-sales-qa.service': {profiles: 'host-ro', state: 'rw', outputs: 'ro'},
  'shein-bi-portal.service': {profiles: 'rw', state: 'rw', outputs: 'rw'},
  'shein-bi-query.service': {profiles: 'none', state: 'ro', outputs: 'ro'},
  'shein-bi-session-secret.service': {profiles: 'none', state: 'rw', outputs: 'ro'},
  'shein-bi-webhook.service': {profiles: 'none', state: 'ro', outputs: 'ro'},
});
assert.deepEqual(validateCloudRuntimePathPolicy(services), {
  ok: true,
  repositoryServiceCount: 28,
  policyServiceCount: 28,
  issues: [],
});

const policyWithoutQuery = {...CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE};
delete policyWithoutQuery['shein-bi-query.service'];
const missing = validateCloudRuntimePathPolicy(services, policyWithoutQuery);
assert.equal(missing.ok, false);
assert.deepEqual(missing.issues, [{code: 'RUNTIME_PATH_POLICY_MISSING', service: 'shein-bi-query.service'}]);

for (const [service, policy] of Object.entries(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE)) {
  assert.deepEqual(Object.keys(policy).sort(), ['outputs', 'profiles', 'state'], service);
  const rendered = renderCloudRuntimePathDropIn(service, policy);
  assert.match(rendered, /^\[Unit\]\nRequiresMountsFor=\/data\/shein-bi\/profiles \/data\/shein-bi\/state \/data\/shein-bi\/outputs\n\n\[Service\]\n/);
  assert.equal(rendered.endsWith('\n'), true);
  const profileBindings = rendered.match(/^(?:BindPaths|BindReadOnlyPaths)=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles$/gm) || [];
  assert.equal(profileBindings.length, policy.profiles === 'none' ? 0 : 1,
    `${service} must have the exact reviewed profile namespace`);
  if (policy.profiles === 'none') {
    assert.match(rendered, /InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles/);
    assert.doesNotMatch(rendered, /profiles:\/opt\/shein-bi\/app\/profiles/);
  } else if (policy.profiles === 'host-ro') {
    assert.match(rendered, /BindReadOnlyPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles/);
    assert.doesNotMatch(rendered, /BindPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles/);
  } else {
    assert.match(rendered, /BindPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles/);
    assert.doesNotMatch(rendered, /BindReadOnlyPaths=\/data\/shein-bi\/profiles:\/opt\/shein-bi\/app\/profiles/);
  }
  const stateDirective = policy.state === 'rw' ? 'BindPaths' : 'BindReadOnlyPaths';
  const outputsDirective = policy.outputs === 'rw' ? 'BindPaths' : 'BindReadOnlyPaths';
  assert.match(rendered, new RegExp(`${stateDirective}=/data/shein-bi/state:/opt/shein-bi/app/state`));
  assert.match(rendered, new RegExp(`${outputsDirective}=/data/shein-bi/outputs:/opt/shein-bi/app/outputs`));
  // Two-sided read-only contract: every non-writable policy must also make the
  // canonical /data/shein-bi source read-only, not just the /opt legacy bind target.
  const expectedReadOnly = [];
  if (policy.profiles === 'host-ro') expectedReadOnly.push('/data/shein-bi/profiles');
  if (policy.state === 'ro') expectedReadOnly.push('/data/shein-bi/state');
  if (policy.outputs === 'ro') expectedReadOnly.push('/data/shein-bi/outputs');
  const directives = cloudRuntimePathDropInDirectives(service, policy);
  assert.deepEqual(directives.readOnlyPaths, expectedReadOnly, `${service} readOnlyPaths must cover every canonically read-only domain`);
  if (expectedReadOnly.length) {
    const readOnlyLine = rendered.match(/^ReadOnlyPaths=(.+)$/m);
    assert.ok(readOnlyLine, `${service} must render a ReadOnlyPaths line`);
    assert.deepEqual(readOnlyLine[1].trim().split(/\s+/u).sort(), [...expectedReadOnly].sort(), `${service} rendered ReadOnlyPaths`);
  } else {
    assert.doesNotMatch(rendered, /^ReadOnlyPaths=/m, `${service} must not render ReadOnlyPaths when every domain is writable`);
  }
  if (policy.profiles === 'none') {
    // none hides both canonical and legacy profile paths; never a ReadOnlyPaths view of profiles.
    assert.doesNotMatch(rendered, /^ReadOnlyPaths=.*\/data\/shein-bi\/profiles/m, `${service} must not expose profiles via ReadOnlyPaths`);
  } else if (policy.profiles === 'host-ro') {
    // host-ro must protect both sides of the profile namespace.
    assert.match(rendered, /^ReadOnlyPaths=.*\/data\/shein-bi\/profiles/m, `${service} host-ro must protect the canonical profile source`);
  }
}

assert.deepEqual(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-lark-sales-qa.service'], {
  profiles: 'host-ro', state: 'rw', outputs: 'ro',
});
const webhookPolicy = CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-webhook.service'];
assert.deepEqual(webhookPolicy, {profiles: 'none', state: 'ro', outputs: 'ro'});
assert.deepEqual(cloudRuntimePathEffectiveDirectives('shein-bi-webhook.service', webhookPolicy), {
  requiresMountsFor: [
    '/data/shein-bi/profiles',
    '/data/shein-bi/state',
    '/data/shein-bi/outputs',
  ],
  bindPaths: [],
  bindReadOnlyPaths: [
    '/data/shein-bi/state:/opt/shein-bi/app/state',
    '/data/shein-bi/outputs:/opt/shein-bi/app/outputs',
  ],
  readOnlyPaths: [
    '/data/shein-bi/state',
    '/data/shein-bi/outputs',
  ],
  inaccessiblePaths: [
    '/data/shein-bi/profiles',
    '/opt/shein-bi/app/profiles',
  ],
});
// Webhook must never receive the 19-store profile namespace because of host-ro.
// It has no Chrome/browser responsibility (ExecStart is only serve_shein_webhook.mjs),
// so both the canonical and legacy profile paths stay inaccessible and the canonical
// source of state/outputs is read-only on both sides.
const webhookRendered = renderCloudRuntimePathDropIn('shein-bi-webhook.service', webhookPolicy);
assert.match(webhookRendered, /^InaccessiblePaths=\/data\/shein-bi\/profiles \/opt\/shein-bi\/app\/profiles$/m);
assert.doesNotMatch(webhookRendered, /^(?:BindPaths|BindReadOnlyPaths)=\/data\/shein-bi\/profiles:/m);
assert.match(webhookRendered, /^ReadOnlyPaths=\/data\/shein-bi\/state \/data\/shein-bi\/outputs$/m);
assert.doesNotMatch(webhookRendered, /^ReadOnlyPaths=.*\/data\/shein-bi\/profiles/m);
assert.deepEqual(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-query.service'], {
  profiles: 'none', state: 'ro', outputs: 'ro',
});
assert.deepEqual(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-session-secret.service'], {
  profiles: 'none', state: 'rw', outputs: 'ro',
});
assert.deepEqual(CLOUD_RUNTIME_EFFECTIVE_PATH_EXTRAS_BY_SERVICE, {
  'shein-bi-query.service': {
    readOnlyPaths: ['/opt/shein-bi/app', '/srv/shein-bi/secrets', '/srv/shein-bi/partner-cli'],
    inaccessiblePaths: [],
  },
  'shein-bi-session-secret.service': {
    readOnlyPaths: ['/opt/shein-bi/app'],
    inaccessiblePaths: ['/srv/shein-bi/secrets'],
  },
});
assert.deepEqual(
  cloudRuntimePathEffectiveDirectives(
    'shein-bi-query.service',
    CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-query.service'],
  ),
  {
    requiresMountsFor: [
      '/data/shein-bi/profiles',
      '/data/shein-bi/state',
      '/data/shein-bi/outputs',
    ],
    bindPaths: [],
    bindReadOnlyPaths: [
      '/data/shein-bi/state:/opt/shein-bi/app/state',
      '/data/shein-bi/outputs:/opt/shein-bi/app/outputs',
    ],
    readOnlyPaths: [
      '/data/shein-bi/state',
      '/data/shein-bi/outputs',
      '/opt/shein-bi/app',
      '/srv/shein-bi/secrets',
      '/srv/shein-bi/partner-cli',
    ],
    inaccessiblePaths: [
      '/data/shein-bi/profiles',
      '/opt/shein-bi/app/profiles',
    ],
  },
);
assert.deepEqual(
  cloudRuntimePathEffectiveDirectives(
    'shein-bi-session-secret.service',
    CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-session-secret.service'],
  ),
  {
    requiresMountsFor: [
      '/data/shein-bi/profiles',
      '/data/shein-bi/state',
      '/data/shein-bi/outputs',
    ],
    bindPaths: ['/data/shein-bi/state:/opt/shein-bi/app/state'],
    bindReadOnlyPaths: ['/data/shein-bi/outputs:/opt/shein-bi/app/outputs'],
    readOnlyPaths: ['/data/shein-bi/outputs', '/opt/shein-bi/app'],
    inaccessiblePaths: [
      '/data/shein-bi/profiles',
      '/opt/shein-bi/app/profiles',
      '/srv/shein-bi/secrets',
    ],
  },
);
const queryUnit = await fs.readFile(path.join(ROOT, 'infra', 'systemd', 'shein-bi-query.service'), 'utf8');
assert.ok(queryUnit.split('\n').includes(
  'ReadOnlyPaths=/opt/shein-bi/app /data/shein-bi/outputs /data/shein-bi/state /srv/shein-bi/secrets /srv/shein-bi/partner-cli',
));
const sessionSecretUnit = await fs.readFile(path.join(ROOT, 'infra', 'systemd', 'shein-bi-session-secret.service'), 'utf8');
assert.ok(sessionSecretUnit.split('\n').includes(
  'ReadOnlyPaths=/opt/shein-bi/app /data/shein-bi/outputs',
));
assert.ok(sessionSecretUnit.split('\n').includes(
  'InaccessiblePaths=/data/shein-bi/profiles /opt/shein-bi/app/profiles /srv/shein-bi/secrets',
));
assert.deepEqual(CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE['shein-bi-cloud-marketing-live-guard.service'], {
  profiles: 'host-ro', state: 'rw', outputs: 'rw',
});

const dataDiskDropIn = await fs.readFile(
  path.join(ROOT, 'infra', 'systemd', 'shein-bi-data-disk-requires-mounts.conf'),
  'utf8',
);
assert.equal(dataDiskDropIn, `[Unit]\nRequiresMountsFor=/data/shein-bi/profiles /data/shein-bi/state /data/shein-bi/outputs /srv/shein-bi/runtime /srv/shein-bi/backups\nAfter=local-fs.target\n`);

// Effective-verification contract: the runtime snapshot/watchdog compares the
// exact effective property tokens returned by `systemctl show` against the
// reviewed directives. Mirroring that comparison here proves it can identify
// an omitted protection and an injected override for every namespace kind,
// including the new canonical-source ReadOnlyPaths dimension.
function namespaceTokens(value) {
  return [...new Set(String(value ?? '').trim().split(/\s+/u).filter(Boolean))].sort();
}
function effectiveNamespace(service) {
  const reviewed = cloudRuntimePathEffectiveDirectives(service, CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE[service]);
  return {
    bindPaths: reviewed.bindPaths.join(' '),
    bindReadOnlyPaths: reviewed.bindReadOnlyPaths.join(' '),
    readOnlyPaths: reviewed.readOnlyPaths.join(' '),
    inaccessiblePaths: reviewed.inaccessiblePaths.join(' '),
  };
}
function effectiveDrift(service, effective) {
  const drift = [];
  for (const property of ['bindPaths', 'bindReadOnlyPaths', 'readOnlyPaths', 'inaccessiblePaths']) {
    const actual = namespaceTokens(effective[property]);
    const reviewed = namespaceTokens(effectiveNamespace(service)[property]);
    if (actual.length !== reviewed.length || actual.some((token, index) => token !== reviewed[index])) drift.push(property);
  }
  return drift;
}

const orderClosure = 'shein-bi-cloud-order-closure.service';
assert.deepEqual(effectiveDrift(orderClosure, effectiveNamespace(orderClosure)), []);
// omission: canonical-source ReadOnlyPaths removed -> detected
assert.deepEqual(effectiveDrift(orderClosure, {...effectiveNamespace(orderClosure), readOnlyPaths: ''}), ['readOnlyPaths']);
// omission: the profile target read-only bind removed -> detected
assert.deepEqual(effectiveDrift(orderClosure, {...effectiveNamespace(orderClosure), bindReadOnlyPaths: ''}), ['bindReadOnlyPaths']);
// override: a writable profile bind injected into a host-ro service -> detected
assert.deepEqual(effectiveDrift(orderClosure, {
  ...effectiveNamespace(orderClosure),
  bindPaths: `${effectiveNamespace(orderClosure).bindPaths} /data/shein-bi/profiles:/opt/shein-bi/app/profiles`.trim(),
}), ['bindPaths']);
// webhook profiles namespace omitted -> detected
assert.deepEqual(effectiveDrift('shein-bi-webhook.service', {...effectiveNamespace('shein-bi-webhook.service'), inaccessiblePaths: ''}), ['inaccessiblePaths']);
// webhook canonical source protection omitted -> detected
assert.deepEqual(effectiveDrift('shein-bi-webhook.service', {...effectiveNamespace('shein-bi-webhook.service'), readOnlyPaths: ''}), ['readOnlyPaths']);
console.log(JSON.stringify({ok: true, policyServices: services.length, exactPolicySet: true}, null, 2));
