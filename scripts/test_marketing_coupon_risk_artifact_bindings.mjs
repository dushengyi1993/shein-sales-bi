#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
} from '../lib/marketing_plan_registry.mjs';
import {resolveCurrentMarketingPlanPair} from '../lib/marketing_plan_selector.mjs';
import {loadCouponTargetEligibilityPlan} from '../lib/marketing_coupon_policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cancelExecutor = path.join(root, 'scripts', 'marketing', 'cancel_coupon_extra_goods.mjs');
const endExecutor = path.join(root, 'scripts', 'marketing', 'end_limited_discounts_for_coupon_plan.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-coupon-risk-bindings-'));
const registryRoot = path.join(tempRoot, 'registry');
const registryFile = path.join(registryRoot, 'current.json');
const selectionFile = path.join(tempRoot, 'selection-plan.json');
const priceFile = path.join(tempRoot, 'price-overrides.json');
const scanFile = path.join(tempRoot, 'scan.json');
const cancelArtifactFile = path.join(tempRoot, 'cancel.json');
const forgedRiskFile = path.join(tempRoot, 'forged-risk.json');
const forgedScanFile = path.join(tempRoot, 'forged-scan.json');
const mutatedFile = path.join(tempRoot, 'mutated.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function rowKey(row) {
  return `${String(row.storeKey).toUpperCase()}:${Number(row.activityId)}:${String(row.skc).toLowerCase()}`;
}

function payloadHash(rows) {
  return sha256(JSON.stringify([...rows].sort((a, b) => rowKey(a).localeCompare(rowKey(b))).map(stableValue)));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function rel(file) {
  return path.relative(root, path.resolve(file)).replaceAll(path.sep, '/');
}

function runNode(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: {...process.env, ...env},
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function snapshotDir(dir) {
  return fs.existsSync(dir) ? new Set(fs.readdirSync(dir)) : null;
}

function removeNewFiles(dir, before) {
  if (!fs.existsSync(dir)) return;
  if (!before) {
    fs.rmSync(dir, {recursive: true, force: true});
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (!before.has(entry)) fs.rmSync(path.join(dir, entry), {recursive: true, force: true});
  }
}

const outputDirs = [
  path.join(root, 'tmp', 'marketing-signup', 'coupon-cancel-results'),
  path.join(root, 'tmp', 'marketing-signup', 'limited-discount-end-results'),
];
const outputBefore = new Map(outputDirs.map(dir => [dir, snapshotDir(dir)]));

try {
  const storesConfig = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8'));
  const storeKeys = storesConfig.stores
    .filter(store => store.enabled !== false)
    .map(store => String(store.storeKey).toUpperCase())
    .sort();
  assert.equal(storeKeys.length, 19, 'fixture expects the managed 19-store config');

  const rows = storeKeys.map((storeKey, index) => ({
    storeKey,
    activityId: 900000 + index,
    skc: `fixture-${storeKey.toLowerCase()}-${index}`,
    supplierNo: `supplier-${index}`,
    targetPrice: 100,
    finalTargetPrice: 100,
    couponFactor: 0.85,
    couponPolicy: 'traffic',
    selected: true,
  }));
  const selectionPayloadHash = payloadHash(rows);
  const pricePayloadHash = payloadHash(rows);
  const workFingerprint = sha256(JSON.stringify({selectionPayloadHash, pricePayloadHash}));
  const planMetadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: 'artifact-binding-fixture',
    promotedAt: '2026-08-24T00:00:00.000Z',
    selectionPayloadHash,
    pricePayloadHash,
    workFingerprint,
  };
  writeJson(selectionFile, {
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata,
    items: rows,
  });
  writeJson(priceFile, {
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata,
    items: rows,
  });
  fs.mkdirSync(registryRoot, {recursive: true});
  await publishMarketingPlanRegistry({
    selectionPath: selectionFile,
    priceOverridesPath: priceFile,
    expectedSelectionSha256: sha256File(selectionFile),
    expectedPriceOverridesSha256: sha256File(priceFile),
    registryRoot,
    registryFile,
    baselineId: 'artifact-binding-fixture',
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys: storeKeys,
  });

  const current = resolveCurrentMarketingPlanPair({root, registryFile});
  const currentPlan = await loadCouponTargetEligibilityPlan({
    root,
    planPath: current.targetPlan,
    priceOverridesPaths: [current.priceOverrides],
    targetDiscountPct: 15,
  });
  const sourceBinding = file => ({path: rel(file), sha256: sha256File(file)});
  const planSources = currentPlan.planSources.map(sourceBinding);
  const priceOverrideSources = currentPlan.priceOverrideSources.map(sourceBinding);
  const planSelection = {
    strategy: current.strategy,
    registryFile: current.registryFile,
    registryHash: current.registryHash,
    selectionPlanPath: rel(current.targetPlan),
    priceOverridesPath: rel(current.priceOverrides),
    selectionPlanHash: current.selectionPlanHash,
    priceOverridesHash: current.priceOverridesHash,
    selectionPayloadHash: current.selectionPayloadHash,
    pricePayloadHash: current.pricePayloadHash,
    workFingerprint: current.workFingerprint,
  };
  const scan = {
    schemaVersion: 'shein-marketing-coupon-low-price-overlap/v1',
    planSelection,
    ordinaryPlanPaths: planSources.map(source => source.path),
    planSources,
    priceOverrideSources,
    priceOverrideSourcePaths: priceOverrideSources.map(source => source.path),
    stores: [],
  };
  writeJson(scanFile, scan);
  const sourceArtifact = {type: 'coupon-low-price-overlap-scan', path: rel(scanFile), sha256: sha256File(scanFile)};
  const cancelArtifact = {
    schemaVersion: 'shein-marketing-coupon-risk-cancel/v1',
    mode: 'risk-cancel-price-below-target',
    riskCancel: true,
    sourceArtifact,
    sourceScan: sourceArtifact.path,
    sourceScanSha256: sourceArtifact.sha256,
    ordinaryPlanPaths: planSources.map(source => source.path),
    planSources,
    priceOverrideSources,
    priceOverrideSourcePaths: priceOverrideSources.map(source => source.path),
    planSelection,
    rows: [],
  };
  writeJson(cancelArtifactFile, cancelArtifact);

  const registryEnv = {SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE: registryFile};
  const forgedRisk = {
    mode: 'risk-cancel-price-below-target',
    riskCancel: true,
    ordinaryPlanPaths: ['tmp/marketing-signup/selection-plan-2026-06-03-ALL-ready.json'],
    rows: [{storeKey: 'JSH', activityId: 34810, levelRuleId: 1, skc: 'forged', riskReason: 'forged'}],
  };
  writeJson(forgedRiskFile, forgedRisk);
  const forgedScan = {
    ...scan,
    planSelection: {...planSelection, strategy: 'offline_non_authoritative', registryFile: '', registryHash: ''},
  };
  writeJson(forgedScanFile, forgedScan);

  for (const [label, script, artifact, extraArgs] of [
    ['cancel forged risk', cancelExecutor, forgedRiskFile, ['--stores', 'JSH', '--extra-list']],
    ['end forged scan', endExecutor, forgedScanFile, ['--stores', 'JSH', '--scan']],
  ]) {
    const before = new Map(outputDirs.map(dir => [dir, snapshotDir(dir)]));
    const result = runNode(script, [...extraArgs, artifact, '--expected-artifact-sha256', sha256File(artifact), '--execute', '--no-launch'], registryEnv);
    assert.notEqual(result.status, 0, `${label} must fail closed`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /\[JSH\]/, `${label} must fail before store/browser processing`);
    for (const dir of outputDirs) {
      const after = snapshotDir(dir);
      assert.deepEqual(after, before.get(dir), `${label} must not create executor output before validation`);
    }
  }

  writeJson(mutatedFile, {rows: []});
  const staleHash = sha256File(mutatedFile);
  writeJson(mutatedFile, {rows: [{forged: true}]});
  for (const [label, script, option] of [
    ['cancel mutated artifact', cancelExecutor, '--extra-list'],
    ['end mutated artifact', endExecutor, '--scan'],
  ]) {
    const before = new Map(outputDirs.map(dir => [dir, snapshotDir(dir)]));
    const result = runNode(script, ['--stores', 'JSH', option, mutatedFile, '--expected-artifact-sha256', staleHash, '--execute', '--no-launch'], registryEnv);
    assert.notEqual(result.status, 0, `${label} must reject same-path byte mutation`);
    assert.match(`${result.stdout}\n${result.stderr}`, /SHA-256 mismatch/i);
    for (const dir of outputDirs) assert.deepEqual(snapshotDir(dir), before.get(dir), `${label} must stop before output mkdir`);
  }

  const endDryRun = runNode(endExecutor, ['--stores', 'JSH', '--scan', scanFile, '--expected-artifact-sha256', sha256File(scanFile), '--dry-run', '--no-launch'], registryEnv);
  assert.equal(endDryRun.status, 0, `normal current-registry scan must reach dry-run: ${endDryRun.stderr}`);
  assert.match(endDryRun.stdout, /\[JSH\]/, 'normal end scan must reach the store dry-run path');
  const cancelDryRun = runNode(cancelExecutor, ['--stores', 'JSH', '--extra-list', cancelArtifactFile, '--expected-artifact-sha256', sha256File(cancelArtifactFile), '--dry-run', '--no-launch'], registryEnv);
  assert.equal(cancelDryRun.status, 0, `normal current-registry cancellation artifact must reach dry-run: ${cancelDryRun.stderr}`);
  assert.match(cancelDryRun.stdout, /\[JSH\]/, 'normal cancellation artifact must reach the store dry-run path');

  console.log('marketing coupon risk artifact bindings: forged/offline rejection, byte-drift rejection, and current-registry dry-run passed');
} finally {
  for (const [dir, before] of outputBefore) removeNewFiles(dir, before);
  fs.rmSync(tempRoot, {recursive: true, force: true});
}
