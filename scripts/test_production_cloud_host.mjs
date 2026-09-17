#!/usr/bin/env node
// The retire-link review, its collector and the cloud team report channel used to
// hardcode shein-bi-tencent. Production moved to shein-bi-fnos on 2026-09-15, so
// the formal entrypoint ssh-ed to a stopped host and silently degraded into an
// offline approximation. These contracts keep exactly one resolvable source of
// truth for the production host.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  PRODUCTION_CLOUD_HOST_DEFAULT,
  PRODUCTION_CLOUD_HOST_ENV_KEYS,
  RETIRED_CLOUD_HOST,
  assertSafeCloudHost,
  resolveProductionCloudHost,
} from '../lib/production_cloud_host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];

assert.equal(PRODUCTION_CLOUD_HOST_DEFAULT, 'shein-bi-fnos', 'the deployed production host is the default');
assert.equal(resolveProductionCloudHost({env: {}}), 'shein-bi-fnos');
assert.equal(resolveProductionCloudHost({explicit: 'probe-host.example', env: {}}), 'probe-host.example', 'an explicit host wins');
assert.equal(resolveProductionCloudHost({env: {[PRODUCTION_CLOUD_HOST_ENV_KEYS[0]]: 'env-host.example'}}), 'env-host.example', 'the environment overrides the default');
assert.equal(
  resolveProductionCloudHost({explicit: 'explicit.example', env: {[PRODUCTION_CLOUD_HOST_ENV_KEYS[0]]: 'env-host.example'}}),
  'explicit.example',
  'an explicit argument beats the environment',
);
for (const bad of ['', ' ', 'bad host', 'host;rm -rf /', '$(id)', '--flag', '-x', 'a'.repeat(200), null, undefined]) {
  assert.throws(() => assertSafeCloudHost(bad), /plain ssh host alias/, `unsafe host must be rejected: ${JSON.stringify(bad)}`);
}
checks.push('host_resolution_order_and_validation');

for (const rel of [
  'scripts/link_retire_review.mjs',
  'scripts/collect_link_retire_review_evidence.mjs',
  'lib/link_retire_review_evidence.mjs',
  'lib/cloud_team_report_common.mjs',
]) {
  assert.ok(!read(rel).includes(RETIRED_CLOUD_HOST), `${rel} must not hardcode the retired host`);
}
checks.push('no_retired_host_in_entrypoints');

const review = read('scripts/link_retire_review.mjs');
assert.match(review, /const cloudHost=resolveProductionCloudHost\(\{explicit:args\['cloud-ssh'\]\|\|''\}\)/, 'the review resolves the host instead of literalising it');
assert.ok(!/!==cloudHost\)throw new Error\('evidence and delivery host/.test(review), '--cloud-ssh must be accepted, not compared against a literal');
assert.match(review, /requestIdentity,host:cloudHost,priorEvidence/, 'the collector request carries the resolved host');
assert.match(review, /cloudSsh:cloudHost/, 'delivery uses the resolved host');
assert.equal((review.match(/\['-o','BatchMode=yes',cloudHost,/g) || []).length, 3, 'collection, delivery claim and delivery readback all ssh to the resolved host');
checks.push('review_entrypoint_threads_resolved_host');

const collector = read('scripts/collect_link_retire_review_evidence.mjs');
assert.ok(!collector.includes(RETIRED_CLOUD_HOST));
assert.match(collector, /request\?\.host \|\| process\.env\.SHEIN_BI_PRODUCTION_CLOUD_HOST \|\| COLLECTOR_HOST/, 'the collector takes an injected host with an environment and constant fallback');
assert.match(collector, /host, \.\.\.collectorIdentity\(\)/, 'evidence records the resolved host plus the local hostname and deployed release');
checks.push('collector_records_injected_host_and_identity');

const probe = spawnSync(process.execPath, ['-e', "import('./lib/cloud_team_report_common.mjs').then(m=>process.stdout.write(m.CLOUD_TEAM_REPORT_CLOUD_HOST))"], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {...process.env, [PRODUCTION_CLOUD_HOST_ENV_KEYS[0]]: 'probe-host.example'},
});
assert.equal(probe.status, 0, probe.stderr);
assert.equal(probe.stdout.trim(), 'probe-host.example', 'the delivery channel host follows the resolved production host');
checks.push('delivery_channel_follows_resolved_host');

const resolvedEvidenceHost = spawnSync(process.execPath, ['-e', "import('./lib/link_retire_review_evidence.mjs').then(m=>process.stdout.write(m.EVIDENCE_HOST))"], {
  cwd: ROOT,
  encoding: 'utf8',
  env: {...process.env, [PRODUCTION_CLOUD_HOST_ENV_KEYS[0]]: 'probe-host.example'},
});
assert.equal(resolvedEvidenceHost.status, 0, resolvedEvidenceHost.stderr);
assert.equal(resolvedEvidenceHost.stdout.trim(), 'probe-host.example', 'the evidence host expectation follows the same source');
checks.push('evidence_host_follows_resolved_host');

console.log(JSON.stringify({ok: true, test: 'production_cloud_host_single_source', checks}));
