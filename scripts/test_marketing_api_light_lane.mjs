import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
  validateMarketingPlanPairDocuments,
} from '../lib/marketing_plan_registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = path.join(root, 'scripts', 'cloud_marketing_live_guard.sh');
const guard = fs.readFileSync(guardPath, 'utf8');

function toBashPath(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function restoreFixturePermissions(root) {
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('fixture cleanup root must be a real directory: ' + root);
  }

  const restoreOwnerAccess = current => {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(current, (stat.mode & 0o777) | 0o700);
      for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
        restoreOwnerAccess(path.join(current, entry.name));
      }
      return;
    }
    if (stat.isFile()) fs.chmodSync(current, (stat.mode & 0o777) | 0o600);
  };

  restoreOwnerAccess(root);
}

function shellFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

const lowMemoryWait = shellFunction(guard, 'wait_for_low_memory_capacity');

function runHarness(lines) {
  const invocation = lines.at(-1);
  return spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: ['set -u', ...lines.slice(0, -1), lowMemoryWait, invocation].join('\n'),
  });
}

const recovered = runHarness([
  'MIN_AVAILABLE_MEM_MIB=100',
  'LOW_MEMORY_RETRY_INTERVAL_SEC=2',
  'LOW_MEMORY_MAX_WAIT_SEC=4',
  'MEMINFO_FILE=/unused',
  'counter_file="${TMPDIR:-/tmp}/marketing-api-light-counter-$$"',
  'printf "0" > "$counter_file"',
  'sleeps=0',
  'available_mem_mib() { local reads; reads=$(<"$counter_file"); reads=$((reads + 1)); printf "%s" "$reads" > "$counter_file"; if (( reads == 1 )); then echo 50; else echo 150; fi; }',
  'sleep() { sleeps=$((sleeps + 1)); }',
  'if wait_for_low_memory_capacity; then printf "recovered elapsed=%s sleeps=%s\\n" "$LOW_MEMORY_WAIT_ELAPSED_SEC" "$sleeps"; rm -f "$counter_file"; else rm -f "$counter_file"; exit 90; fi',
]);
assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
assert.match(recovered.stdout, /recovered elapsed=2 sleeps=1/);

const timedOut = runHarness([
  'MIN_AVAILABLE_MEM_MIB=100',
  'LOW_MEMORY_RETRY_INTERVAL_SEC=2',
  'LOW_MEMORY_MAX_WAIT_SEC=3',
  'MEMINFO_FILE=/unused',
  'counter_file="${TMPDIR:-/tmp}/marketing-api-light-counter-$$"',
  'printf "0" > "$counter_file"',
  'sleeps=0',
  'available_mem_mib() { local reads; reads=$(<"$counter_file"); reads=$((reads + 1)); printf "%s" "$reads" > "$counter_file"; echo 50; }',
  'sleep() { sleeps=$((sleeps + 1)); }',
  'if wait_for_low_memory_capacity; then rm -f "$counter_file"; exit 91; else status=$?; printf "blocked status=%s elapsed=%s sleeps=%s\\n" "$status" "$LOW_MEMORY_WAIT_ELAPSED_SEC" "$sleeps"; rm -f "$counter_file"; exit "$status"; fi',
]);
assert.equal(timedOut.status, 1, timedOut.stderr || timedOut.stdout);
assert.match(timedOut.stdout, /blocked status=1 elapsed=3 sleeps=2/);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-marketing-api-light-'));
try {
  const tempMeminfo = path.join(tempRoot, 'meminfo');
  const bashTempRoot = toBashPath(tempRoot);
  const bashTempMeminfo = toBashPath(tempMeminfo);
  const bashGuardPath = toBashPath(guardPath);
  fs.mkdirSync(path.join(tempRoot, 'scripts', 'lib'), {recursive: true});
  fs.mkdirSync(path.join(tempRoot, 'lib'), {recursive: true});
  fs.mkdirSync(path.join(tempRoot, 'config'), {recursive: true});
  fs.copyFileSync(path.join(root, 'config', 'stores.json'), path.join(tempRoot, 'config', 'stores.json'));
  fs.copyFileSync(path.join(root, 'lib', 'atomic_file_publish.mjs'), path.join(tempRoot, 'lib', 'atomic_file_publish.mjs'));
  fs.copyFileSync(path.join(root, 'lib', 'marketing_plan_registry.mjs'), path.join(tempRoot, 'lib', 'marketing_plan_registry.mjs'));
  fs.writeFileSync(path.join(tempRoot, 'scripts', 'lib', 'shared_lock.sh'), [
    '#!/usr/bin/env bash',
    'prepare_shared_lock_file() { mkdir -p "$(dirname "$1")"; }',
    '',
  ].join('\n'));
  fs.writeFileSync(tempMeminfo, 'MemAvailable:        1024 kB\n');

  const storesConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
  const storeKeys = storesConfig.stores
    .filter(store => store.enabled !== false)
    .map(store => String(store.storeKey).toUpperCase())
    .sort();
  const rows = storeKeys.map((storeKey, index) => ({
    storeKey,
    activityId: 80000 + index,
    skc: `api-light-${storeKey.toLowerCase()}-${index}`,
    targetPrice: 50,
    finalTargetPrice: 50,
    cost: 20,
    storageUnitCostSar: 0.5,
    selected: true,
  }));
  const validated = validateMarketingPlanPairDocuments({
    selection: {items: rows},
    prices: {items: rows},
    requireCurrentBaseline: false,
    expectedStoreCount: 19,
    expectedStoreKeys: storeKeys,
  });
  const planMetadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: 'api-light-fixture',
    promotedAt: '2026-08-24T00:00:00.000Z',
    selectionPayloadHash: validated.selectionPayloadHash,
    pricePayloadHash: validated.pricePayloadHash,
    workFingerprint: validated.workFingerprint,
  };
  const selectionFile = path.join(tempRoot, 'selection.json');
  const pricesFile = path.join(tempRoot, 'prices.json');
  const decorate = items => ({
    items,
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata,
  });
  fs.writeFileSync(selectionFile, `${JSON.stringify(decorate(rows), null, 2)}\n`, 'utf8');
  fs.writeFileSync(pricesFile, `${JSON.stringify(decorate(rows), null, 2)}\n`, 'utf8');

  const registryRoot = path.join(tempRoot, 'runtime', 'marketing-plans');
  const registryFile = path.join(registryRoot, 'current.json');
  fs.mkdirSync(registryRoot, {recursive: true});
  await publishMarketingPlanRegistry({
    selectionPath: selectionFile,
    priceOverridesPath: pricesFile,
    expectedSelectionSha256: sha256(fs.readFileSync(selectionFile)),
    expectedPriceOverridesSha256: sha256(fs.readFileSync(pricesFile)),
    registryRoot,
    registryFile,
    baselineId: 'api-light-fixture',
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys: storeKeys,
  });

  const blockedRun = spawnSync('bash', [], {
    cwd: root,
    encoding: 'utf8',
    input: [
      `export SHEIN_BI_ROOT='${bashTempRoot}'`,
      `export SHEIN_BI_MARKETING_LIVE_MEMINFO_FILE='${bashTempMeminfo}'`,
      'export SHEIN_BI_MARKETING_LIVE_MIN_AVAILABLE_MEM_MIB=2200',
      'export SHEIN_BI_MARKETING_LIVE_LOW_MEMORY_RETRY_INTERVAL_SEC=1',
      'export SHEIN_BI_MARKETING_LIVE_LOW_MEMORY_MAX_WAIT_SEC=0',
      `export SHEIN_BI_MARKETING_LIVE_STATE_DIR='${toBashPath(path.join(tempRoot, 'state', 'cloud_marketing_live_guard'))}'`,
      `export SHEIN_BI_MARKETING_LIVE_LOG_DIR='${toBashPath(path.join(tempRoot, 'logs'))}'`,
      `export SHEIN_BI_MARKETING_LIVE_LOCK_FILE='${toBashPath(path.join(tempRoot, 'state', 'locks', 'guard.lock'))}'`,
      `export SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE='${toBashPath(registryFile)}'`,
      'export SHEIN_BI_MARKETING_LIVE_RUN_ID=low-memory-terminal-test',
      'export SHEIN_BI_MARKETING_LIVE_IGNORE_RESERVED_WINDOW=1',
      `exec bash '${bashGuardPath}'`,
      '',
    ].join('\n'),
  });
  assert.equal(blockedRun.status, 1, blockedRun.stderr || blockedRun.stdout);
  if (!fs.existsSync(path.join(tempRoot, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json'))) {
    throw new Error(`blocked guard output missing\nstdout=${blockedRun.stdout}\nstderr=${blockedRun.stderr}`);
  }
  const statePath = path.join(tempRoot, 'state', 'cloud_ops_alerts', 'marketing-live-guard-last.json');
  const runReportDir = path.join(tempRoot, 'state', 'cloud_marketing_live_guard', 'reports');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.status, 'blocked_low_memory');
  const reports = fs.readdirSync(runReportDir);
  assert.equal(reports.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runReportDir, reports[0]), 'utf8')).status, 'blocked_low_memory');
} finally {
  restoreFixturePermissions(tempRoot);
  fs.rmSync(tempRoot, {recursive: true, force: true});
}

console.log('marketing api-light lane: ok');
