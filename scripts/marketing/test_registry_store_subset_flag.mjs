#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
  resolveStoreCoverageExpectation,
  validateMarketingPlanPairDocuments,
  verifyMarketingPlanRegistrySync,
} from '../../lib/marketing_plan_registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sha256Text = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// A newly enabled store can legitimately have no enrollable ordinary campaign yet: the platform
// returns no eligible entries for it, so it contributes zero baseline rows. That has to stay
// publishable behind one explicit, auditable allowance.
//
// The allowance used to be a parameter that every coverage check forwarded by hand - pair check,
// candidate readback, terminal readback - and each missed forward failed production only at the
// very last check. Four release attempts died that way. The rule now has a single decision point
// (resolveStoreCoverageExpectation) whose resolved store set is what all later checks compare
// against, so the structural assertions below guard the shape, not just today's call sites.
const enabledStores = ['AAA', 'BBB', 'CCC'];
const planStores = ['AAA', 'BBB'];

function rows(storeKeys) {
  return storeKeys.map((storeKey, index) => ({
    storeKey,
    activityId: 71000,
    skc: `sv-subset-${index}`,
    targetPrice: 120 + index,
    finalTargetPrice: 120 + index,
    cost: 40,
    storageUnitCostSar: 0.5,
    selected: true,
  }));
}

function pairDocuments(storeKeys = planStores) {
  const items = rows(storeKeys);
  const initial = validateMarketingPlanPairDocuments({
    selection: {items},
    prices: {items},
    requireCurrentBaseline: false,
  });
  const planMetadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: 'subset-fixture-batch',
    promotedAt: '2026-09-17T01:02:03.000Z',
    selectionPayloadHash: initial.selectionPayloadHash,
    pricePayloadHash: initial.pricePayloadHash,
    workFingerprint: initial.workFingerprint,
  };
  const decorate = () => ({
    items,
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata,
  });
  return {selection: decorate(), prices: decorate()};
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-subset-flag-'));

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const text = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, text, 'utf8');
  return text;
}

async function main() {
  // 1. The decision point: exact coverage, the explicit allowance, and out-of-scope stores.
  assert.equal(
    resolveStoreCoverageExpectation({planStoreKeys: enabledStores, enabledStoreKeys: enabledStores}).mode,
    'exact',
    'full coverage is exact',
  );
  assert.throws(
    () => resolveStoreCoverageExpectation({planStoreKeys: planStores, enabledStoreKeys: enabledStores}),
    /enabled store coverage mismatch/i,
    'a partial plan is rejected without the allowance',
  );
  assert.throws(
    () => resolveStoreCoverageExpectation({planStoreKeys: planStores, enabledStoreKeys: [], expectedStoreCount: 3}),
    /must cover 3 stores/,
    'a count-only expectation still applies without an enabled-store config',
  );
  const allowed = resolveStoreCoverageExpectation({
    planStoreKeys: planStores,
    enabledStoreKeys: enabledStores,
    allowEnabledStoreSubset: true,
  });
  assert.equal(allowed.mode, 'enabled_subset', 'the allowance resolves to an enabled-store subset');
  assert.deepEqual(allowed.expectedStoreKeys, planStores, 'the resolved expectation is the plan own store set');
  assert.deepEqual(allowed.missingEnabledStoreKeys, ['CCC'], 'the uncovered enabled store stays visible as advice');
  assert.throws(
    () => resolveStoreCoverageExpectation({
      planStoreKeys: [...planStores, 'ZZZ'],
      enabledStoreKeys: enabledStores,
      allowEnabledStoreSubset: true,
    }),
    /outside enabled store coverage/i,
    'the allowance never admits a store outside the enabled set',
  );

  const docs = pairDocuments();
  const validatedSubset = validateMarketingPlanPairDocuments({
    selection: docs.selection,
    prices: docs.prices,
    requireCurrentBaseline: false,
    expectedStoreKeys: enabledStores,
    allowStoreCoverageSubset: true,
  });
  assert.equal(validatedSubset.storeCoverage.mode, 'enabled_subset', 'the pair check reports the resolved mode');
  assert.deepEqual(validatedSubset.storeKeys, planStores, 'pair validation keeps the plan own store set');
  assert.throws(
    () => validateMarketingPlanPairDocuments({
      selection: docs.selection,
      prices: docs.prices,
      requireCurrentBaseline: false,
      expectedStoreKeys: enabledStores,
    }),
    /enabled store coverage mismatch/i,
    'pair validation stays exact without the allowance',
  );

  // 2. End-to-end: publish a subset plan, then verify it the two ways production does.
  const registryRoot = path.join(tmpRoot, 'runtime', 'marketing-plans');
  const registryFile = path.join(registryRoot, 'current.json');
  const selectionPath = path.join(tmpRoot, 'source', 'selection-plan.json');
  const pricesPath = path.join(tmpRoot, 'source', 'price-overrides.json');
  const selectionText = writeJson(selectionPath, docs.selection);
  const pricesText = writeJson(pricesPath, docs.prices);
  const commonPublishArgs = {
    selectionPath,
    priceOverridesPath: pricesPath,
    expectedSelectionSha256: sha256Text(selectionText),
    expectedPriceOverridesSha256: sha256Text(pricesText),
    registryRoot,
    registryFile,
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys: enabledStores,
  };
  await assert.rejects(
    publishMarketingPlanRegistry({...commonPublishArgs, baselineId: 'subset-baseline-strict'}),
    /must cover 3 stores/,
    'publishing a subset plan without the allowance is refused',
  );
  assert.equal(fs.existsSync(registryFile), false, 'a refused publish must not create the current pointer');

  const published = await publishMarketingPlanRegistry({
    ...commonPublishArgs,
    baselineId: 'subset-baseline-20260917',
    allowStoreCoverageSubset: true,
  });
  assert.equal(published.rowCount, planStores.length, 'the subset baseline publishes its own rows');
  assert.deepEqual(published.storeKeys, planStores, 'the subset baseline records its own store set');

  const advisory = verifyMarketingPlanRegistrySync({
    registryFile,
    registryRoot,
    expectedStoreKeys: enabledStores,
    allowEnabledStoreSubset: true,
  });
  assert.equal(advisory.registryHash, published.registryHash, 'the operator readback returns the published registry');
  assert.equal(advisory.storeCoverageComplete, false, 'the operator readback still reports the missing enabled store');
  assert.deepEqual(advisory.missingEnabledStoreKeys, ['CCC'], 'the operator readback names the missing enabled store');
  assert.equal(advisory.storeCoverageMode, 'enabled_subset', 'the operator readback reports the resolved coverage mode');

  // This is the invariant four releases broke: the plan own resolved store set verifies with no
  // allowance forwarded at all, which is exactly how the terminal readback runs inside publish.
  const resolved = verifyMarketingPlanRegistrySync({
    registryFile,
    registryRoot,
    expectedStoreKeys: published.storeKeys,
  });
  assert.equal(resolved.registryHash, published.registryHash, 'the resolved store set verifies without any allowance');
  assert.equal(resolved.storeCoverageComplete, true, 'the resolved store set is complete by construction');

  // 3. Structure: the allowance is decided once and forwarded by nobody downstream.
  const lib = read('lib/marketing_plan_registry.mjs');
  const publishBody = lib.slice(lib.indexOf('export async function publishMarketingPlanRegistry('));
  assert.ok(
    publishBody.includes('const expectedStores = validated.storeKeys;'),
    'publish normalizes the coverage contract once, from the validated plan',
  );
  const afterNormalization = publishBody.slice(publishBody.indexOf('const expectedStores = validated.storeKeys;'));
  assert.equal(
    (afterNormalization.match(/allowStoreCoverageSubset/g) || []).length,
    0,
    'no coverage check after normalization may depend on the subset allowance',
  );
  assert.equal(
    (publishBody.match(/allowStoreCoverageSubset/g) || []).length,
    2,
    'the publish path declares the allowance and consumes it exactly once',
  );
  const verifyBody = lib.slice(
    lib.indexOf('export function verifyMarketingPlanRegistrySync('),
    lib.indexOf('export const verifyMarketingPlanRegistry ='),
  );
  assert.ok(
    verifyBody.includes('planStoreKeys: registry.pair?.storeKeys'),
    'registry verification resolves coverage from the registry own declared store set',
  );
  assert.ok(
    !verifyBody.includes('allowStoreCoverageSubset'),
    'registry verification consumes the allowance instead of forwarding it',
  );
  assert.ok(
    lib.includes('async function publishVerifiedCurrentPointer({file, root, registry, expectedStores, onBeforeReplace})'),
    'the candidate readback takes the resolved store set, not the allowance',
  );
  assert.ok(
    !publishBody.includes('allowEnabledStoreSubset'),
    'the publish path never forwards the allowance into a downstream readback',
  );

  const cli = read('scripts/marketing/manage_marketing_plan_registry.mjs');
  assert.ok(cli.includes('--allow-enabled-store-subset'), 'registry CLI exposes --allow-enabled-store-subset');
  assert.equal(
    (cli.match(/allowEnabledStoreSubset === true/g) || []).length,
    2,
    'the CLI forwards the allowance in both verify and publish',
  );
  assert.ok(
    cli.includes('const storesConfig = args.storesConfig || defaultStoresConfig();'),
    'the CLI defaults the coverage expectation instead of verifying nothing',
  );

  // 3b. The CLI verify run must really enforce coverage: without --stores-config it uses this
  // repository's config/stores.json, which cannot contain these fixture stores, so a clean report
  // is impossible. A silently empty expectation used to make verify print a green coverage line
  // while checking nothing.
  const cliPath = path.join(ROOT, 'scripts', 'marketing', 'manage_marketing_plan_registry.mjs');
  const runCli = extraArgs =>
    spawnSync(process.execPath, [
      cliPath,
      'verify',
      '--registry-file', registryFile,
      '--registry-root', registryRoot,
      ...extraArgs,
    ], {cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});

  const defaultConfigVerify = runCli([]);
  assert.notEqual(defaultConfigVerify.status, 0, 'verify without --stores-config must apply the repository enabled-store expectation');
  assert.match(
    `${defaultConfigVerify.stdout}\n${defaultConfigVerify.stderr}`,
    /enabled store coverage mismatch/i,
    'verify without --stores-config reports the real coverage mismatch',
  );

  const fixtureStoresConfig = path.join(tmpRoot, 'config', 'stores.json');
  writeJson(fixtureStoresConfig, {stores: enabledStores.map(storeKey => ({storeKey}))});
  const fixtureVerify = runCli(['--stores-config', fixtureStoresConfig, '--allow-enabled-store-subset']);
  assert.equal(fixtureVerify.status, 0, `${fixtureVerify.stdout}\n${fixtureVerify.stderr}`);
  const fixtureResult = JSON.parse(fixtureVerify.stdout);
  assert.equal(fixtureResult.storeCoverageComplete, false, 'the CLI reports the uncovered enabled store as advice');
  assert.deepEqual(fixtureResult.missingEnabledStoreKeys, ['CCC'], 'the CLI names the uncovered enabled store');
  assert.equal(fixtureResult.storesConfig, fixtureStoresConfig, 'the CLI reports which enabled-store config it applied');
  assert.deepEqual(fixtureResult.enabledStoreKeys, [...enabledStores].sort(), 'the CLI reports the enabled-store expectation it applied');

  // 4. Real enrollment arrives in ordered waves (base -> exec -> run -> run2, then supplements and
  // re-reports). A later manifest supersedes an earlier row; treating that as a hard duplicate
  // error forced operators to hand-derive a pruned partition before anything could be published.
  const promoter = read('scripts/marketing/promote_composite_ordinary_campaign_baseline.mjs');
  assert.ok(promoter.includes('function resolveApprovedUnion('), 'approval waves resolve in manifest order');
  assert.ok(!promoter.includes('Duplicate ${label} row across approval manifests'), 'supersession is no longer a hard duplicate error');
  assert.ok(promoter.includes('--allow-enabled-store-subset'), 'composite promoter exposes the subset flag');
  assert.equal(
    (promoter.match(/allowStoreCoverageSubset: args\.allowEnabledStoreSubset === true/g) || []).length >= 2,
    true,
    'every promoter coverage check carries the subset flag',
  );
}

try {
  await main();
} finally {
  restoreFixturePermissions(tmpRoot);
  fs.rmSync(tmpRoot, {recursive: true, force: true});
}
console.log(JSON.stringify({ok: true, test: 'registry_publish_enabled_store_subset_and_superseding_approvals'}));
