#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = path.join(root, 'scripts', 'cloud_marketing_live_guard.sh');
const repairPath = path.join(root, 'scripts', 'cloud_marketing_repair_worker.sh');
const publishPath = path.join(root, 'scripts', 'publish_marketing_price_leads_to_bi.sh');
const guard = fs.readFileSync(guardPath, 'utf8');
const repair = fs.readFileSync(repairPath, 'utf8');
const publish = fs.readFileSync(publishPath, 'utf8');
const expectedLock = '/opt/shein-bi/app/state/locks/shein-bi-cloud-marketing-artifact-publication.lock';

assert.equal((guard.match(/shein-bi-cloud-marketing-artifact-publication\.lock/g) || []).length > 0, true);
assert.equal((repair.match(/shein-bi-cloud-marketing-artifact-publication\.lock/g) || []).length > 0, true);
assert.equal((publish.match(/shein-bi-cloud-marketing-artifact-publication\.lock/g) || []).length > 0, true);
assert.match(guard, /flock -w/);
assert.match(repair, /flock -w/);
assert.match(publish, /flock -w/);
assert.match(guard, /return 75/);
assert.match(repair, /return 75/);
assert.match(publish, /return 75/);
assert.match(guard, /SHEIN_BI_HOST_RESOURCE_LANE/);
assert.doesNotMatch(guard, /^Slice=/m);
assert.doesNotMatch(guard, /run_cloud_marketing_fallback_slot\.sh/);
assert.doesNotMatch(guard, /systemctl\s+is-active/);

const service = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-marketing-live-guard.service'),
  'utf8',
);
const repairService = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-marketing-repair.service'),
  'utf8',
);
assert.match(service, new RegExp(`Environment=SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE=${expectedLock.replaceAll('/', '\\/')}`));
assert.match(repairService, new RegExp(`Environment=SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE=${expectedLock.replaceAll('/', '\\/')}`));

function toBashPath(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function exportLines(values) {
  return Object.entries(values).map(([name, value]) => `export ${name}=${JSON.stringify(String(value))}`);
}

fs.mkdirSync(path.join(root, 'tmp'), {recursive: true});
const tempRoot = fs.mkdtempSync(path.join(root, 'tmp', 'marketing-artifact-lock-'));
const bashRoot = toBashPath(tempRoot);
const lockFile = path.join(tempRoot, 'state', 'locks', 'artifact.lock');
const bashLockFile = toBashPath(lockFile);
const leadsFile = path.join(tempRoot, 'outputs', 'bi-portal', 'marketing-price-leads.json');
const bashLeadsFile = toBashPath(leadsFile);
const enqueueLog = path.join(tempRoot, 'enqueue.log');
const bashEnqueueLog = toBashPath(enqueueLog);
const bashPublishPath = toBashPath(publishPath);

try {
  fs.mkdirSync(path.join(tempRoot, 'scripts', 'lib'), {recursive: true});
  fs.mkdirSync(path.join(tempRoot, 'scripts', 'marketing'), {recursive: true});
  fs.mkdirSync(path.join(tempRoot, 'lib'), {recursive: true});
  fs.copyFileSync(path.join(root, 'lib', 'atomic_file_publish.mjs'), path.join(tempRoot, 'lib', 'atomic_file_publish.mjs'));
  fs.writeFileSync(path.join(tempRoot, 'scripts', 'lib', 'shared_lock.sh'), [
    '#!/usr/bin/env bash',
    'prepare_shared_lock_file() { return 0; }',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tempRoot, 'scripts', 'marketing', 'export_marketing_price_leads_for_bi.mjs'), [
    "import fs from 'node:fs/promises';",
    "import path from 'node:path';",
    "const args = process.argv;",
    "const out = args[args.indexOf('--out') + 1];",
    "await fs.mkdir(path.dirname(out), {recursive: true});",
    "await fs.writeFile(out, JSON.stringify({generatedAt: new Date().toISOString(), rows: [{store_key: 'DX', skc: 'SKC-001', value: 42}]}));",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tempRoot, 'scripts', 'enqueue_bi_portal_sections.sh'), [
    '#!/usr/bin/env bash',
    'set -Eeuo pipefail',
    'printf "%q " "$@" >> "$SHEIN_TEST_ENQUEUE_LOG"',
    'printf "\\n" >> "$SHEIN_TEST_ENQUEUE_LOG"',
    '',
  ].join('\n'));

  const shellVariables = {
    SHEIN_BI_ROOT: bashRoot,
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE: bashLockFile,
    SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_WAIT_SEC: '0',
    SHEIN_BI_MARKETING_PRICE_LEADS_FILE: bashLeadsFile,
    SHEIN_BI_MARKETING_BI_PUBLISH_DATE: '2026-08-22',
    SHEIN_BI_MARKETING_BI_PUBLISH_REASON: 'focused-lock-test',
    SHEIN_BI_MARKETING_BI_PUBLISH_PRIORITY: '10',
    SHEIN_TEST_ENQUEUE_LOG: bashEnqueueLog,
    SHEIN_TEST_PUBLISH_PATH: bashPublishPath,
  };

  const busy = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: [...exportLines(shellVariables),
    'set -Eeuo pipefail',
    'lock="$SHEIN_BI_MARKETING_ARTIFACT_PUBLICATION_LOCK_FILE"',
    'mkdir -p "$(dirname "$lock")"',
    'touch "$lock"',
    'exec 7<>"$lock"',
    'flock -n 7',
    'source "$SHEIN_BI_ROOT/scripts/lib/shared_lock.sh"',
    'source "$SHEIN_TEST_PUBLISH_PATH"',
  ].join('\n'),
  });
  assert.equal(busy.status, 75, `${busy.stdout}\n${busy.stderr}`);
  assert.match(`${busy.stdout}\n${busy.stderr}`, /artifact publication lock busy/);

  const first = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: [...exportLines(shellVariables),
      'source "$SHEIN_BI_ROOT/scripts/lib/shared_lock.sh"',
      'source "$SHEIN_TEST_PUBLISH_PATH"'].join('\n'),
  });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const second = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: [...exportLines(shellVariables),
      'source "$SHEIN_BI_ROOT/scripts/lib/shared_lock.sh"',
      'source "$SHEIN_TEST_PUBLISH_PATH"'].join('\n'),
  });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);

  const log = fs.readFileSync(enqueueLog, 'utf8');
  const keys = [...log.matchAll(/--idempotency-key\s+([A-Za-z0-9._:-]+)/g)].map(match => match[1]);
  assert.equal(keys.length, 2, log);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^marketing-linksData:2026-08-22:sha256:[a-f0-9]{64}$/);

  const queueFile = path.join(tempRoot, 'portal-section-queue.json');
  const managerPath = path.join(root, 'scripts', 'manage_bi_portal_section_queue.mjs');
  const managerArgs = [
    managerPath,
    'enqueue',
    '--sections', 'linksData',
    '--core-generated-at', 'core-2026-08-22',
    '--priority', '10',
    '--reason', 'focused-idempotency-test',
    '--idempotency-key', keys[0],
    '--file', queueFile,
  ];
  const queueFirst = spawnSync(process.execPath, managerArgs, {cwd: root, encoding: 'utf8'});
  const queueSecond = spawnSync(process.execPath, managerArgs, {cwd: root, encoding: 'utf8'});
  assert.equal(queueFirst.status, 0, `${queueFirst.stdout}\n${queueFirst.stderr}`);
  assert.equal(queueSecond.status, 0, `${queueSecond.stdout}\n${queueSecond.stderr}`);
  const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  assert.equal(queue.entries.length, 1);
  assert.equal(queue.entries[0].section, 'linksData');
  assert.equal(queue.entries[0].idempotencyKey, `${keys[0]}::linksData`);
  assert.equal(queue.entries[0].requestRevision, 1);
  console.log('marketing artifact publication lock: ok');
} finally {
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
