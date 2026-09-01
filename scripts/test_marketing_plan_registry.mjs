#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  canonicalSha256,
  validateMarketingPlanPairDocuments,
} from '../lib/marketing_plan_registry.mjs';
import {resolveCurrentMarketingPlanPair} from '../lib/marketing_plan_selector.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-registry-'));
const testTmpRoots = new Set([root]);
const registryRoot = path.join(root, 'runtime', 'marketing-plans');
const registryFile = path.join(registryRoot, 'current.json');
const stores = Array.from({length: 19}, (_, index) => `S${String(index + 1).padStart(2, '0')}`);
const storesConfig = path.join(root, 'config', 'stores.json');
const sourceDir = path.join(root, 'source');
const selectionPath = path.join(sourceDir, 'selection-plan-source.json');
const pricePath = path.join(sourceDir, 'price-overrides-source.json');
const manager = path.resolve('scripts/marketing/manage_marketing_plan_registry.mjs');
const baselineId = 'fixture-baseline-001';

function cleanupTestTmpRoot(tmpRoot) {
  if (!testTmpRoots.has(tmpRoot)) {
    throw new Error(`refusing to clean up an unregistered test tmp root: ${tmpRoot}`);
  }

  let rootStat;
  try {
    rootStat = fs.lstatSync(tmpRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`refusing to clean up a non-directory test tmp root: ${tmpRoot}`);
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

  restoreOwnerAccess(tmpRoot);
  fs.rmSync(tmpRoot, {recursive: true, force: true});
}

function throwTestAndCleanupErrors(testError, cleanupError, label) {
  if (testError && cleanupError) {
    throw new AggregateError([testError, cleanupError], `${label} and cleanup both failed`);
  }
  if (testError) throw testError;
  if (cleanupError) throw cleanupError;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rows(price = 25) {
  return stores.map((storeKey, index) => ({
    storeKey,
    activityId: 70000 + (index % 2),
    skc: `sv-fixture-${String(index).padStart(3, '0')}`,
    targetPrice: price + index / 100,
    finalTargetPrice: price + index / 100,
    cost: 10,
    storageUnitCostSar: 0.5,
    selected: true,
  }));
}

function writePair({selection = rows(), prices = selection, executionStatus = 'completed', target = selectionPath, price = pricePath} = {}) {
  const initial = validateMarketingPlanPairDocuments({
    selection: {items: selection},
    prices: {items: prices},
    requireCurrentBaseline: false,
    expectedStoreCount: 19,
  });
  const metadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: 'fixture-activity-batch',
    promotedAt: '2026-08-24T01:02:03.000Z',
    selectionPayloadHash: initial.selectionPayloadHash,
    pricePayloadHash: initial.pricePayloadHash,
    workFingerprint: initial.workFingerprint,
  };
  const decorate = source => ({
    items: source,
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus,
    planMetadata: metadata,
  });
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.mkdirSync(path.dirname(price), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(decorate(selection), null, 2)}\n`);
  fs.writeFileSync(price, `${JSON.stringify(decorate(prices), null, 2)}\n`);
  return {target, price};
}

function publishResult(selection = selectionPath, price = pricePath, id = baselineId, {
  targetRegistryRoot = registryRoot,
  targetRegistryFile = registryFile,
  env = {},
} = {}) {
  return spawnSync(process.execPath, [
    manager,
    'publish',
    '--selection', selection,
    '--prices', price,
    '--registry-root', targetRegistryRoot,
    '--registry-file', targetRegistryFile,
    '--baseline-id', id,
    '--expected-selection-sha256', sha256(selection),
    '--expected-prices-sha256', sha256(price),
    '--stores-config', storesConfig,
    '--confirm', MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  ], {cwd: path.resolve('.'), env: {...process.env, ...env}, encoding: 'utf8'});
}

function publish(selection = selectionPath, price = pricePath, id = baselineId) {
  const result = publishResult(selection, price, id);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

let registryTestError = null;
let registryCleanupError = null;
try {
  fs.mkdirSync(path.dirname(storesConfig), {recursive: true});
  fs.writeFileSync(storesConfig, JSON.stringify({stores: stores.map(storeKey => ({storeKey}))}));
  writePair();
  const published = publish();
  assert.equal(published.ok, true);
  assert.equal(published.rowCount, 19);
  assert.deepEqual(published.storeKeys, stores);

  const verify = spawnSync(process.execPath, [
    manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile, '--stores-config', storesConfig,
  ], {cwd: path.resolve('.'), encoding: 'utf8'});
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  const verified = JSON.parse(verify.stdout);
  assert.equal(verified.registryHash, published.registryHash);

  const currentBeforeFaults = fs.readFileSync(registryFile);
  const candidateFaultSelection = path.join(sourceDir, 'selection-candidate-fault.json');
  const candidateFaultPrice = path.join(sourceDir, 'prices-candidate-fault.json');
  writePair({selection: rows(27), prices: rows(27), target: candidateFaultSelection, price: candidateFaultPrice});
  const candidateFault = publishResult(candidateFaultSelection, candidateFaultPrice, 'fixture-candidate-fault', {
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_candidate_verify',
    },
  });
  assert.notEqual(candidateFault.status, 0, 'candidate verification fault must fail publish');
  assert.match(`${candidateFault.stdout}\n${candidateFault.stderr}`, /injected test fault: after_candidate_verify/i);
  assert.equal(fs.readFileSync(registryFile).equals(currentBeforeFaults), true,
    'verified candidate failure must leave previous current pointer bytes untouched');

  const replaceFaultSelection = path.join(sourceDir, 'selection-replace-fault.json');
  const replaceFaultPrice = path.join(sourceDir, 'prices-replace-fault.json');
  writePair({selection: rows(28), prices: rows(28), target: replaceFaultSelection, price: replaceFaultPrice});
  const replaceFault = publishResult(replaceFaultSelection, replaceFaultPrice, 'fixture-replace-fault', {
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_current_pointer_replace',
    },
  });
  assert.notEqual(replaceFault.status, 0, 'post-replace fault must fail publish');
  assert.match(`${replaceFault.stdout}\n${replaceFault.stderr}`, /injected test fault: after_current_pointer_replace/i);
  assert.equal(fs.readFileSync(registryFile).equals(currentBeforeFaults), true,
    'post-replace failure must restore previous current pointer bytes exactly');
  const verifiedAfterReplaceFault = spawnSync(process.execPath, [
    manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile, '--stores-config', storesConfig,
  ], {cwd: path.resolve('.'), encoding: 'utf8'});
  assert.equal(verifiedAfterReplaceFault.status, 0, `${verifiedAfterReplaceFault.stdout}\n${verifiedAfterReplaceFault.stderr}`);
  assert.equal(JSON.parse(verifiedAfterReplaceFault.stdout).registryHash, published.registryHash,
    'post-replace rollback must preserve the previously verified registry');

  const newPointerRoot = path.join(root, 'new-pointer-runtime');
  const newPointerFile = path.join(newPointerRoot, 'current.json');
  const newPointerSelection = path.join(sourceDir, 'selection-new-pointer-fault.json');
  const newPointerPrice = path.join(sourceDir, 'prices-new-pointer-fault.json');
  writePair({selection: rows(29), prices: rows(29), target: newPointerSelection, price: newPointerPrice});
  const newPointerFault = publishResult(newPointerSelection, newPointerPrice, 'fixture-new-pointer-fault', {
    targetRegistryRoot: newPointerRoot,
    targetRegistryFile: newPointerFile,
    env: {
      NODE_ENV: 'test',
      SHEIN_MARKETING_PLAN_REGISTRY_TEST_FAULT: 'after_current_pointer_replace',
    },
  });
  assert.notEqual(newPointerFault.status, 0, 'post-replace fault without a previous pointer must fail publish');
  assert.equal(fs.existsSync(newPointerFile), false,
    'post-replace failure must remove a newly-created current pointer when no previous pointer existed');

  const selected = resolveCurrentMarketingPlanPair({root, registryFile, nowMs: Date.parse('2026-08-24T04:00:00+08:00')});
  assert.equal(selected.strategy, 'registry_current_baseline');
  assert.equal(selected.registryHash, published.registryHash);
  assert.equal(selected.selectionPlanHash, sha256(path.join(registryRoot, 'baselines', baselineId, 'selection-plan.json')));
  assert.equal(selected.priceOverridesHash, sha256(path.join(registryRoot, 'baselines', baselineId, 'price-overrides.json')));

  const lockPath = path.join(registryRoot, '.publish.lock');
  fs.mkdirSync(lockPath);
  const locked = spawnSync(process.execPath, [
    manager, 'publish', '--selection', selectionPath, '--prices', pricePath,
    '--registry-root', registryRoot, '--registry-file', registryFile, '--baseline-id', baselineId,
    '--expected-selection-sha256', sha256(selectionPath), '--expected-prices-sha256', sha256(pricePath),
    '--stores-config', storesConfig, '--confirm', MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  ], {encoding: 'utf8'});
  assert.notEqual(locked.status, 0, 'an existing publish lock must fail closed');
  assert.match(`${locked.stdout}\n${locked.stderr}`, /publish lock/i);
  assert.equal(fs.existsSync(lockPath), true, 'publish must not silently reclaim an existing lock');
  fs.rmdirSync(lockPath);

  const originalRegistryText = fs.readFileSync(registryFile, 'utf8');
  const nestedRegistry = JSON.parse(originalRegistryText);
  const immutableBaselineDir = path.join(registryRoot, 'baselines', baselineId);
  const nestedBaselineDir = path.join(immutableBaselineDir, 'nested');
  const immutableBaselineMode = fs.lstatSync(immutableBaselineDir).mode & 0o777;
  let nestedFixtureError = null;
  let immutableModeRestoreError = null;
  try {
    fs.chmodSync(immutableBaselineDir, immutableBaselineMode | 0o700);
    fs.mkdirSync(nestedBaselineDir);
  } catch (error) {
    nestedFixtureError = error;
  } finally {
    try {
      fs.chmodSync(immutableBaselineDir, immutableBaselineMode);
    } catch (error) {
      immutableModeRestoreError = error;
    }
  }
  throwTestAndCleanupErrors(nestedFixtureError, immutableModeRestoreError, 'nested baseline fixture');
  assert.equal(fs.lstatSync(immutableBaselineDir).mode & 0o777, immutableBaselineMode,
    'nested-path fixture must restore the immutable baseline directory mode before verify');
  nestedRegistry.manifestPath = `baselines/${baselineId}/nested/manifest.json`;
  const nestedRegistryBase = {...nestedRegistry};
  delete nestedRegistryBase.canonicalRegistryHash;
  delete nestedRegistryBase.registryHash;
  nestedRegistry.canonicalRegistryHash = canonicalSha256(nestedRegistryBase);
  nestedRegistry.registryHash = nestedRegistry.canonicalRegistryHash;
  fs.writeFileSync(registryFile, `${JSON.stringify(nestedRegistry, null, 2)}\n`);
  const nestedVerify = spawnSync(process.execPath, [manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile], {encoding: 'utf8'});
  assert.notEqual(nestedVerify.status, 0, 'nested manifest paths must be rejected');
  assert.equal(fs.lstatSync(immutableBaselineDir).mode & 0o777, immutableBaselineMode,
    'nested-path verification must leave the immutable baseline directory mode unchanged');
  fs.writeFileSync(registryFile, originalRegistryText);

  const otherBaselineDir = path.join(registryRoot, 'baselines', `other-${baselineId}`);
  fs.mkdirSync(otherBaselineDir, {recursive: true});
  const basenameRegistry = JSON.parse(originalRegistryText);
  basenameRegistry.manifestPath = `baselines/${path.basename(otherBaselineDir)}/manifest.json`;
  const basenameRegistryBase = {...basenameRegistry};
  delete basenameRegistryBase.canonicalRegistryHash;
  delete basenameRegistryBase.registryHash;
  basenameRegistry.canonicalRegistryHash = canonicalSha256(basenameRegistryBase);
  basenameRegistry.registryHash = basenameRegistry.canonicalRegistryHash;
  fs.writeFileSync(registryFile, `${JSON.stringify(basenameRegistry, null, 2)}\n`);
  const basenameVerify = spawnSync(process.execPath, [manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile], {encoding: 'utf8'});
  assert.notEqual(basenameVerify.status, 0, 'baseline directory basename mismatch must be rejected');
  fs.writeFileSync(registryFile, originalRegistryText);

  const symlinkPath = path.join(registryRoot, 'baselines', `symlink-${baselineId}`);
  const symlinkTarget = path.join(root, 'outside-baseline');
  fs.mkdirSync(symlinkTarget, {recursive: true});
  let symlinkCreated = false;
  try {
    fs.symlinkSync(symlinkTarget, symlinkPath, 'junction');
    symlinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) throw error;
  }
  if (symlinkCreated) {
    const symlinkRegistry = JSON.parse(originalRegistryText);
    symlinkRegistry.manifestPath = `baselines/${path.basename(symlinkPath)}/manifest.json`;
    const symlinkRegistryBase = {...symlinkRegistry};
    delete symlinkRegistryBase.canonicalRegistryHash;
    delete symlinkRegistryBase.registryHash;
    symlinkRegistry.canonicalRegistryHash = canonicalSha256(symlinkRegistryBase);
    symlinkRegistry.registryHash = symlinkRegistry.canonicalRegistryHash;
    fs.writeFileSync(registryFile, `${JSON.stringify(symlinkRegistry, null, 2)}\n`);
    const symlinkVerify = spawnSync(process.execPath, [manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile], {encoding: 'utf8'});
    assert.notEqual(symlinkVerify.status, 0, 'symlink baseline paths must be rejected');
    fs.writeFileSync(registryFile, originalRegistryText);
  }

  const explicit = resolveCurrentMarketingPlanPair({
    root,
    targetPlan: selectionPath,
    priceOverrides: pricePath,
    targetPlanExplicit: true,
    priceOverridesExplicit: true,
  });
  assert.equal(explicit.strategy, 'explicit_both');
  assert.equal(explicit.targetPlan, path.resolve(selectionPath));
  assert.equal(explicit.priceOverrides, path.resolve(pricePath));
  assert.equal(explicit.selectionPlanHash, sha256(selectionPath));

  const publishedSelection = path.join(registryRoot, 'baselines', baselineId, 'selection-plan.json');
  const originalSelection = fs.readFileSync(publishedSelection);
  fs.chmodSync(publishedSelection, 0o644);
  fs.writeFileSync(publishedSelection, Buffer.from(`${originalSelection}\n`));
  const tamperedVerify = spawnSync(process.execPath, [manager, 'verify', '--registry-root', registryRoot, '--registry-file', registryFile], {encoding: 'utf8'});
  assert.notEqual(tamperedVerify.status, 0, 'tampered immutable plan must fail verify');
  fs.writeFileSync(publishedSelection, originalSelection);

  const collisionSelection = path.join(sourceDir, 'selection-collision.json');
  const collisionPrice = path.join(sourceDir, 'prices-collision.json');
  writePair({selection: rows(26), prices: rows(26), target: collisionSelection, price: collisionPrice});
  const collision = spawnSync(process.execPath, [
    manager, 'publish', '--selection', collisionSelection, '--prices', collisionPrice,
    '--registry-root', registryRoot, '--registry-file', registryFile, '--baseline-id', baselineId,
    '--expected-selection-sha256', sha256(collisionSelection), '--expected-prices-sha256', sha256(collisionPrice),
    '--stores-config', storesConfig, '--confirm', MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  ], {encoding: 'utf8'});
  assert.notEqual(collision.status, 0, 'same baselineId with different bytes must fail closed');

  const pendingSelection = path.join(sourceDir, 'selection-pending.json');
  const pendingPrice = path.join(sourceDir, 'prices-pending.json');
  writePair({executionStatus: 'pending_execution', target: pendingSelection, price: pendingPrice});
  const pending = spawnSync(process.execPath, [
    manager, 'publish', '--selection', pendingSelection, '--prices', pendingPrice,
    '--registry-root', path.join(root, 'pending-runtime'), '--registry-file', path.join(root, 'pending-runtime', 'current.json'),
    '--baseline-id', 'pending-baseline', '--expected-selection-sha256', sha256(pendingSelection),
    '--expected-prices-sha256', sha256(pendingPrice), '--stores-config', storesConfig,
    '--confirm', MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  ], {encoding: 'utf8'});
  assert.notEqual(pending.status, 0, 'pending_execution plan must be rejected');

  assert.throws(() => resolveCurrentMarketingPlanPair({
    root,
    registryFile: path.join(root, 'missing', 'current.json'),
  }), /missing|registry/i);
} catch (error) {
  registryTestError = error;
} finally {
  try {
    cleanupTestTmpRoot(root);
  } catch (error) {
    registryCleanupError = error;
  }
}
throwTestAndCleanupErrors(registryTestError, registryCleanupError, 'marketing plan registry fixture');

const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-legacy-'));
testTmpRoots.add(legacyRoot);
let legacyTestError = null;
let legacyCleanupError = null;
try {
  const legacyDir = path.join(legacyRoot, 'tmp', 'marketing-signup');
  fs.mkdirSync(legacyDir, {recursive: true});
  const legacy = rows();
  fs.writeFileSync(path.join(legacyDir, 'selection-plan-2026-06-03-ALL-ready.json'), JSON.stringify({items: legacy, baselineForNextOrdinaryActivity: true, baselineForLimitedDiscountFallback: true, executionStatus: 'completed', planMetadata: {status: 'current_baseline'}}));
  fs.writeFileSync(path.join(legacyDir, 'price-overrides-2026-06-03-ALL-ready.json'), JSON.stringify({items: legacy, baselineForNextOrdinaryActivity: true, baselineForLimitedDiscountFallback: true, executionStatus: 'completed', planMetadata: {status: 'current_baseline'}}));
  assert.throws(() => resolveCurrentMarketingPlanPair({root: legacyRoot}), /verified durable registry.*current\.json|registry is not configured/i);
} catch (error) {
  legacyTestError = error;
} finally {
  try {
    cleanupTestTmpRoot(legacyRoot);
  } catch (error) {
    legacyCleanupError = error;
  }
}
throwTestAndCleanupErrors(legacyTestError, legacyCleanupError, 'legacy marketing plan fixture');

console.log(JSON.stringify({ok: true, checks: [
  'valid_registry_selection',
  'tampered_plan_hash_rejected',
  'pending_execution_rejected',
  'missing_registry_fail_closed',
  'explicit_pair_and_legacy_fallback_guards',
  'publish_lock_is_exclusive_and_not_reclaimed',
  'verified_candidate_fault_preserves_previous_current_bytes',
  'post_replace_fault_restores_previous_current_bytes',
  'post_replace_fault_removes_new_current_without_previous_pointer',
  'nested_baseline_path_rejected',
  'baseline_basename_mismatch_rejected',
  'symlink_baseline_path_rejected_when_supported',
  'publish_verify_immutable_collision',
]}, null, 2));
