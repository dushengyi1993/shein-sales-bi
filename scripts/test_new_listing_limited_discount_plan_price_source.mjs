#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

import {
  MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
  publishMarketingPlanRegistry,
  validateMarketingPlanPairDocuments,
} from '../lib/marketing_plan_registry.mjs';
import {loadExactFallbackRepairPlan} from '../lib/marketing_repair_manifest.mjs';

const root = path.resolve('.');
const date = '2026-08-24';
const stores = JSON.parse(fs.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8')).stores
  .filter(store => store.enabled !== false)
  .map(store => store.storeKey);
assert.equal(stores.length, 19);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function pairRows() {
  return stores.map((storeKey, index) => ({
    storeKey,
    activityId: 88000,
    skc: `registry-skc-${String(index).padStart(3, '0')}`,
    canonical: 'REGISTRY-ONLY',
    targetPrice: 40 + index / 100,
    finalTargetPrice: 40 + index / 100,
    selected: true,
  }));
}

function writeRegistryPair(selectionPath, pricePath) {
  const selectionRows = pairRows();
  const priceRows = selectionRows.map(row => ({...row}));
  const initial = validateMarketingPlanPairDocuments({
    selection: {items: selectionRows},
    prices: {items: priceRows},
    requireCurrentBaseline: false,
    expectedStoreCount: 19,
    expectedStoreKeys: stores,
  });
  const planMetadata = {
    status: 'current_baseline',
    supersededBy: null,
    activityBatch: 'builder-source-fixture',
    promotedAt: '2026-08-24T01:02:03.000Z',
    selectionPayloadHash: initial.selectionPayloadHash,
    pricePayloadHash: initial.pricePayloadHash,
    workFingerprint: initial.workFingerprint,
  };
  const decorate = items => ({
    items,
    baselineForNextOrdinaryActivity: true,
    baselineForLimitedDiscountFallback: true,
    executionStatus: 'completed',
    planMetadata,
  });
  writeJson(selectionPath, decorate(selectionRows));
  writeJson(pricePath, decorate(priceRows));
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
function runBuilder(fixture, extraArgs = []) {
  return spawnSync(process.execPath, [
    'scripts/marketing/build_new_listing_limited_discount_plan.mjs',
    '--date', date,
    '--links-data', fixture.linksData,
    '--out-dir', fixture.outDir,
    '--report-json', fixture.reportJson,
    '--report-md', fixture.reportMd,
    '--current-marketing-live-scan', fixture.liveScan,
    '--link-history-dir', fixture.linkHistoryDir,
    '--stores-config', fixture.storesConfig,
    '--inventory-trend', fixture.inventoryTrend,
    '--cost-map', fixture.missingCostMap,
    '--supplemental-price-overrides-dir', fixture.supplementalDir,
    ...extraArgs,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE: fixture.registryFile,
    },
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'new-listing-registry-price-source-'));
try {
  const fixture = {
    linksData: path.join(tmp, 'linksData.json'),
    storesConfig: path.join(tmp, 'stores.json'),
    inventoryTrend: path.join(tmp, 'inventoryTrend.json'),
    liveScan: path.join(tmp, 'live-scan.json'),
    linkHistoryDir: path.join(tmp, 'shein-links'),
    supplementalDir: path.join(tmp, 'supplemental'),
    missingCostMap: path.join(tmp, 'missing-cost-map.json'),
    costMap: path.join(tmp, 'marketing-cost-map.json'),
    outDir: path.join(tmp, 'out-default'),
    reportJson: path.join(tmp, 'report-default.json'),
    reportMd: path.join(tmp, 'report-default.md'),
    registryRoot: path.join(tmp, 'runtime', 'marketing-plans'),
    registryFile: path.join(tmp, 'runtime', 'marketing-plans', 'current.json'),
  };
  const policyPath = path.join(tmp, 'pricing-policy.json');
  const selectionPath = path.join(tmp, 'selection-source.json');
  const pricesPath = path.join(tmp, 'prices-source.json');

  writeJson(fixture.storesConfig, {stores: [{storeKey: 'JY', enabled: true}]});
  writeJson(fixture.inventoryTrend, {
    products: [{
      canonical: 'SUPPLEMENT-ONLY',
      inventory_match_status: 'matched',
      operational_sellable_qty: 11,
      operational_snapshot_date: date,
    }],
  });
  writeJson(fixture.linksData, {
    generatedAt: `${date}T10:00:00+08:00`,
    storeLinks: [{
      store_key: 'JY',
      skc: 'supplement-only-skc',
      standard_goods_sn: 'SUPPLEMENT-ONLY',
      raw_goods_sn: 'SUPPLEMENT-ONLY',
      is_on_shelf: true,
      shelf_status_name: '已上架',
      shelf_age_days: 2,
      c7_eps_uv: 10,
    }],
  });
  writeJson(fixture.liveScan, {
    ok: true,
    stores: [{storeKey: 'JY', ok: true}],
    rows: [],
  });
  writeJson(path.join(fixture.linkHistoryDir, 'JY', `${date}.json`), {
    ok: true,
    date,
    fetchTime: `${date} 10:10:00`,
    store: {storeKey: 'JY'},
    linkRows: [],
  });
  writeJson(policyPath, {
    exposureTopLinks: {enabled: false},
    relistedWithoutActiveMarketing: {enabled: false},
    mandatoryOnShelfLimitedDiscount: {enabled: false},
  });
  writeJson(fixture.costMap, {
    costMap: {'SUPPLEMENT-ONLY': 10},
    trueCostMap: {},
  });

  const supplementalRows = [{
    storeKey: 'JY',
    activityId: 99000,
    skc: 'supplement-only-skc',
    canonical: 'SUPPLEMENT-ONLY',
    targetPrice: 77.77,
    finalTargetPrice: 77.77,
    isTopExposureLink: true,
  }];
  while (supplementalRows.length < 100) {
    supplementalRows.push({
      storeKey: 'JY',
      activityId: 99000,
      skc: `supplement-filler-${supplementalRows.length}`,
      canonical: 'SUPPLEMENT-FILLER',
      targetPrice: 50,
      finalTargetPrice: 50,
    });
  }
  writeJson(path.join(fixture.supplementalDir, 'price-overrides-supplement.json'), {
    items: supplementalRows,
    baselineForLimitedDiscountFallback: true,
  });
  writeRegistryPair(selectionPath, pricesPath);
  const published = await publishMarketingPlanRegistry({
    selectionPath,
    priceOverridesPath: pricesPath,
    expectedSelectionSha256: sha256(selectionPath),
    expectedPriceOverridesSha256: sha256(pricesPath),
    registryRoot: fixture.registryRoot,
    registryFile: fixture.registryFile,
    baselineId: 'builder-source-fixture',
    confirm: MARKETING_PLAN_REGISTRY_CONFIRM_TOKEN,
    expectedStoreKeys: stores,
  });

  const defaultResult = runBuilder(fixture, ['--pricing-policy', policyPath]);
  assert.equal(defaultResult.status, 0, defaultResult.stderr || defaultResult.stdout);
  const defaultReport = JSON.parse(fs.readFileSync(fixture.reportJson, 'utf8'));
  assert.equal(defaultReport.pricePlanSelection.strategy, 'registry_current_baseline');
  assert.equal(defaultReport.pricePlanSelection.registryHash, published.registryHash);
  assert.equal(defaultReport.supplementalPriceOverridesEnabled, false);
  assert.equal(defaultReport.supplementalPriceOverridesPolicy, 'disabled_by_default');
  assert.deepEqual(defaultReport.supplementalPriceOverrides, []);
  assert.equal(defaultReport.rows.length, 0, 'supplement-only price must not be used by default');
  assert.equal(defaultReport.blocked.length, 1);
  assert.equal(defaultReport.blocked[0].reason, 'missing_price_and_product_cost_evidence_for_canonical');

  fixture.outDir = path.join(tmp, 'out-explicit-missing-hash');
  fixture.reportJson = path.join(tmp, 'report-explicit-missing-hash.json');
  fixture.reportMd = path.join(tmp, 'report-explicit-missing-hash.md');
  const explicitMissingHashResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--price-overrides', published.priceOverrides,
    '--no-supplemental-price-overrides', 'true',
  ]);
  assert.notEqual(explicitMissingHashResult.status, 0);
  assert.match(explicitMissingHashResult.stderr, /--price-overrides requires --expected-price-overrides-sha256/);
  assert.equal(fs.existsSync(fixture.reportJson), false, 'explicit price source without a hash must fail before plan output');

  fixture.outDir = path.join(tmp, 'out-cost-bound');
  fixture.reportJson = path.join(tmp, 'report-cost-bound.json');
  fixture.reportMd = path.join(tmp, 'report-cost-bound.md');
  const costBoundHash = sha256(fixture.costMap);
  const costBoundResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--cost-map', fixture.costMap,
    '--expected-marketing-cost-map-sha256', costBoundHash,
    '--no-supplemental-price-overrides', 'true',
  ]);
  assert.equal(costBoundResult.status, 0, costBoundResult.stderr || costBoundResult.stdout);
  const costBoundReport = JSON.parse(fs.readFileSync(fixture.reportJson, 'utf8'));
  assert.deepEqual(costBoundReport.marketingCostMapSource, {
    path: path.resolve(fixture.costMap),
    sha256: costBoundHash,
    expectedSha256: costBoundHash,
    verified: true,
    exists: true,
  });
  assert.equal(costBoundReport.rows.length, 1, 'bound cost map must provide the missing canonical fallback price');
  const rescueManifest = JSON.parse(fs.readFileSync(path.resolve(root, costBoundReport.rescueFiles[0].path), 'utf8'));
  assert.deepEqual(rescueManifest.marketingCostMapSource, costBoundReport.marketingCostMapSource);
  assert.equal(rescueManifest.sourcePriceOverrides, costBoundReport.sourcePriceOverrides);
  assert.equal(rescueManifest.sourcePriceOverridesSha256, costBoundReport.sourcePriceOverridesSha256);
  assert.equal(rescueManifest.priceOverridesSha256, costBoundReport.priceOverridesSha256);

  fixture.outDir = path.join(tmp, 'out-cost-drift');
  fixture.reportJson = path.join(tmp, 'report-cost-drift.json');
  fixture.reportMd = path.join(tmp, 'report-cost-drift.md');
  const costDriftResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--cost-map', fixture.costMap,
    '--expected-marketing-cost-map-sha256', '0'.repeat(64),
    '--no-supplemental-price-overrides', 'true',
  ]);
  assert.notEqual(costDriftResult.status, 0);
  assert.match(costDriftResult.stderr, /Marketing cost map SHA-256 mismatch/);
  assert.equal(fs.existsSync(fixture.reportJson), false, 'cost-map SHA drift must fail before publishing a summary');

  fixture.outDir = path.join(tmp, 'out-explicit-bound');
  fixture.reportJson = path.join(tmp, 'report-explicit-bound.json');
  fixture.reportMd = path.join(tmp, 'report-explicit-bound.md');
  const explicitBoundResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--price-overrides', published.priceOverrides,
    '--expected-price-overrides-sha256', published.priceOverridesHash,
    '--no-supplemental-price-overrides', 'true',
  ]);
  assert.equal(explicitBoundResult.status, 0, explicitBoundResult.stderr || explicitBoundResult.stdout);
  const explicitBoundReport = JSON.parse(fs.readFileSync(fixture.reportJson, 'utf8'));
  assert.equal(explicitBoundReport.pricePlanSelection.strategy, 'explicit_argument');
  assert.equal(explicitBoundReport.sourcePriceOverrides, path.relative(root, published.priceOverrides).replaceAll(path.sep, '/'));
  assert.equal(explicitBoundReport.sourcePriceOverridesSha256, published.priceOverridesHash);
  assert.equal(explicitBoundReport.priceOverridesPath, explicitBoundReport.sourcePriceOverrides);
  assert.equal(explicitBoundReport.priceOverridesSha256, published.priceOverridesHash);
  assert.equal(explicitBoundReport.expectedPriceOverridesSha256, published.priceOverridesHash);
  assert.equal(explicitBoundReport.actualPriceOverridesSha256, published.priceOverridesHash);
  assert.equal(explicitBoundReport.priceOverridesSha256Verified, true);
  assert.deepEqual(explicitBoundReport.priceOverridesBinding, {
    source: 'explicit_argument',
    expectedSha256: published.priceOverridesHash,
    actualSha256: published.priceOverridesHash,
    verified: true,
  });
  assert.equal(explicitBoundReport.supplementalPriceOverridesEnabled, false);
  assert.deepEqual(explicitBoundReport.supplementalPriceOverrides, []);

  fixture.outDir = path.join(tmp, 'out-explicit-drift');
  fixture.reportJson = path.join(tmp, 'report-explicit-drift.json');
  fixture.reportMd = path.join(tmp, 'report-explicit-drift.md');
  const explicitDriftResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--price-overrides', published.priceOverrides,
    '--expected-price-overrides-sha256', '0'.repeat(64),
    '--no-supplemental-price-overrides', 'true',
  ]);
  assert.notEqual(explicitDriftResult.status, 0);
  assert.match(explicitDriftResult.stderr, /Price overrides SHA-256 mismatch/);
  assert.equal(fs.existsSync(fixture.reportJson), false, 'SHA drift must fail before publishing a summary');

  fixture.outDir = path.join(tmp, 'out-allowed');
  fixture.reportJson = path.join(tmp, 'report-allowed.json');
  fixture.reportMd = path.join(tmp, 'report-allowed.md');
  const allowedResult = runBuilder(fixture, [
    '--pricing-policy', policyPath,
    '--allow-supplemental-price-overrides', 'true',
  ]);
  assert.equal(allowedResult.status, 0, allowedResult.stderr || allowedResult.stdout);
  const allowedReport = JSON.parse(fs.readFileSync(fixture.reportJson, 'utf8'));
  assert.equal(allowedReport.supplementalPriceOverridesEnabled, true);
  assert.equal(allowedReport.supplementalPriceOverridesPolicy, 'explicit_allow_flag');
  assert.equal(allowedReport.supplementalPriceOverrides.length, 1);
  assert.equal(allowedReport.rows.length, 1, 'explicit allow must enable the supplemental fixture');
  assert.equal(allowedReport.rows[0].limitedDiscountPrice, 77.77);
  assert.equal(allowedReport.rows[0].supplementalPriceEvidence, true);

  const preflightGuardPath = path.join(tmp, 'preflight-guard.json');
  const preflightPlanPath = path.join(tmp, 'preflight-plan.json');
  const preflightRescuePath = path.join(tmp, 'preflight-rescue.json');
  const preflightPriceFile = path.join(tmp, 'preflight-price-overrides.json');
  fs.writeFileSync(preflightPriceFile, fs.readFileSync(published.priceOverrides));
  const preflightSourceGuard = path.relative(tmp, preflightGuardPath).replaceAll(path.sep, '/');
  const preflightPricePath = path.relative(tmp, preflightPriceFile).replaceAll(path.sep, '/');
  const preflightLiveScan = 'live-scan.json';
  const preflightPriceHash = sha256(preflightPriceFile);
  writeJson(preflightGuardPath, {
    reportDate: date,
    limitedDiscountTargetPriceDrift: {source: preflightLiveScan},
    targetPlanSelection: {
      strategy: 'registry_current_baseline',
      priceOverrides: preflightPricePath,
      priceOverridesHash: preflightPriceHash,
    },
  });
  writeJson(preflightRescuePath, {
    storeKey: 'JY',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
    sourceGuard: preflightSourceGuard,
    sourcePriceOverrides: preflightPricePath,
    sourcePriceOverridesSha256: preflightPriceHash,
    rows: [{storeKey: 'JY', skc: 'preflight-skc', limitedDiscountPrice: 20, finalTargetPrice: 20}],
  });
  writeJson(preflightPlanPath, {
    reportDate: date,
    sourceGuard: preflightSourceGuard,
    sourceCurrentMarketingLiveScan: preflightLiveScan,
    sourcePriceOverrides: preflightPricePath,
    sourcePriceOverridesSha256: preflightPriceHash,
    priceOverridesSha256: preflightPriceHash,
    expectedPriceOverridesSha256: preflightPriceHash,
    actualPriceOverridesSha256: preflightPriceHash,
    rescueFiles: [{storeKey: 'JY', path: path.relative(tmp, preflightRescuePath).replaceAll(path.sep, '/'), count: 1}],
  });
  const fakeExecutorMarker = path.join(tmp, 'fake-executor-browser-mutation.marker');
  const executeAfterPricePreflight = async () => {
    const exact = await loadExactFallbackRepairPlan({
      root: tmp,
      planPath: preflightPlanPath,
      guardPath: preflightGuardPath,
      date,
    });
    fs.writeFileSync(fakeExecutorMarker, 'executor/browser mutation\n');
    return exact;
  };
  const exactPreflight = await executeAfterPricePreflight();
  assert.equal(exactPreflight.priceOverridesSha256, preflightPriceHash);
  assert.equal(fs.readFileSync(fakeExecutorMarker, 'utf8'), 'executor/browser mutation\n');
  fs.rmSync(fakeExecutorMarker, {force: true});
  fs.writeFileSync(preflightPriceFile, '{"items":[{"mutated":true}]}\n');
  await assert.rejects(
    () => executeAfterPricePreflight(),
    /Price overrides SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(fakeExecutorMarker), false, 'price drift must fail before the fake executor/browser mutation');
} finally {
  restoreFixturePermissions(tmp);
  fs.rmSync(tmp, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, test: 'new_listing_registry_and_explicit_sha_bound_price_source'}));
