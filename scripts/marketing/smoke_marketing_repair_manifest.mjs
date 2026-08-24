#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadExactManualRepairPlan,
  loadExactDriftRepairManifest,
  loadExactFallbackRepairPlan,
} from '../../lib/marketing_repair_manifest.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let portableWindowsDir = '';

const batchSource = await fs.readFile(new URL('./batch_fix_limited_discount_drift.mjs', import.meta.url), 'utf8');
assert.match(batchSource, /replace_limited_discount_transactionally\.mjs/,
  'drift repair must delegate replacement safety to the durable transaction wrapper');
assert.match(batchSource, /executeLimitedDiscountWithInventoryTransaction/,
  'the batch must wrap every live mutation in the shared activity-inventory transaction');
assert.match(batchSource, /runSubmit:\s*async\s*\(\)\s*=>\s*await replaceTransactionally/,
  'the transactional replacement must be the submit callback inside the inventory transaction');
assert.doesNotMatch(batchSource, /remove_skc_from_limited_discount\.mjs/,
  'the batch must not contain a direct delete path outside the transaction wrapper');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-repair-manifest-'));
try {
  const date = '2026-07-18';
  const guardPath = path.join(root, 'outputs', 'reports', `marketing-daily-guard-${date}.json`);
  const planDir = path.join(root, 'tmp', 'marketing-signup', 'limited-discount-fallback', `target-price-drift-${date}`);
  await fs.mkdir(path.dirname(guardPath), {recursive: true});
  await fs.mkdir(planDir, {recursive: true});
  const liveScan = `tmp/marketing-signup/current-price-live/current-marketing-price-live-${date}.json`;
  const priceOverrides = 'tmp/marketing-signup/price-overrides-current.json';
  const priceOverridesPath = path.join(root, priceOverrides);
  await fs.mkdir(path.dirname(priceOverridesPath), {recursive: true});
  await fs.writeFile(priceOverridesPath, '{"items":[]}' + String.fromCharCode(10));
  const priceOverridesHash = sha256(await fs.readFile(priceOverridesPath));
  await fs.writeFile(guardPath, `${JSON.stringify({
    reportDate: date,
    limitedDiscountTargetPriceDrift: {source: liveScan},
    targetPlanSelection: {
      strategy: 'registry_current_baseline',
      priceOverrides,
      priceOverridesHash,
    },
  })}\n`);

  const sourceGuard = `outputs/reports/marketing-daily-guard-${date}.json`;
  const rescueName = `limited-drift-rescue-DL-current-abc12345-${date}.json`;
  const rescueRelative = `tmp/marketing-signup/limited-discount-fallback/target-price-drift-${date}/${rescueName}`;
  const rescue = {
    createdAt: '2026-07-18T00:00:00.000Z',
    storeKey: 'DL',
    purpose: `limited_discount_target_price_drift_rescue_${date}`,
    sourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv1', limitedDiscountPrice: 10, finalTargetPrice: 10}],
  };
  await fs.writeFile(path.join(planDir, rescueName), `${JSON.stringify(rescue)}\n`);
  // This file deliberately matches the old broad glob but is not in the exact
  // manifest. It must never be selected for execution.
  await fs.writeFile(path.join(planDir, `limited-drift-rescue-DL-stale-deadbeef-${date}.json`), `${JSON.stringify({...rescue, rows: [{storeKey: 'DL', skc: 'stale'}]})}\n`);
  const manifest = {
    reportDate: date,
    sourceGuard,
    rescueFiles: [{storeKey: 'DL', path: rescueRelative, count: 1}],
  };
  const manifestPath = path.join(planDir, `limited-discount-target-drift-rescue-plan-${date}.json`);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

  const loaded = await loadExactDriftRepairManifest({root, planDir, guardPath, date});
  assert.equal(loaded.entries.length, 1);
  assert.equal(loaded.entries[0].rescue.rows[0].skc, 'sv1');
  assert.match(loaded.workFingerprint, /^[a-f0-9]{64}$/);

  const fallbackDir = path.join(root, 'tmp', 'marketing-signup', 'limited-discount-fallback', `new-listing-7d-${date}`);
  await fs.mkdir(fallbackDir, {recursive: true});
  const fallbackName = `limited-DL-existing-on-shelf-missing-limited-discount-${date}-20260725-s10.json`;
  const fallbackRelative = `tmp/marketing-signup/limited-discount-fallback/new-listing-7d-${date}/${fallbackName}`;
  const fallbackRescue = {
    createdAt: new Date().toISOString(),
    storeKey: 'DL',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
    sourceGuard,
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesHash,
    priceOverridesSha256: priceOverridesHash,
    rows: [{storeKey: 'DL', skc: 'sv2', limitedDiscountPrice: 20, finalTargetPrice: 20}],
  };
  const fallbackRescuePath = path.join(fallbackDir, fallbackName);
  const fallbackRescueText = `${JSON.stringify(fallbackRescue)}\n`;
  await fs.writeFile(fallbackRescuePath, fallbackRescueText);
  await fs.writeFile(path.join(fallbackDir, `limited-DL-stale-${date}-20260725-s10.json`), `${JSON.stringify({...fallbackRescue, rows: [{storeKey: 'DL', skc: 'stale2'}]})}\n`);
  const fallbackPlanPath = path.join(root, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${date}.json`);
  const fallbackPlan = {
    reportDate: date,
    sourceGuard,
    sourceCurrentMarketingLiveScan: liveScan,
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesHash,
    priceOverridesSha256: priceOverridesHash,
    rescueFiles: [{storeKey: 'DL', path: fallbackRelative, count: 1}],
  };
  const fallbackPlanText = `${JSON.stringify(fallbackPlan)}\n`;
  await fs.writeFile(fallbackPlanPath, fallbackPlanText);
  const loadedFallback = await loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date});
  assert.equal(loadedFallback.entries.length, 1);
  assert.equal(loadedFallback.entries[0].rescue.rows[0].skc, 'sv2');
  assert.equal(loadedFallback.priceOverridesRelativePath, priceOverrides);
  assert.equal(loadedFallback.entries[0].relativePath, fallbackRelative);
  assert.equal(loadedFallback.workFingerprint, sha256(JSON.stringify({
    planHash: sha256(fallbackPlanText),
    guard: sourceGuard,
    priceOverrides: [priceOverrides, priceOverridesHash],
    files: [[fallbackRelative, sha256(fallbackRescueText)]],
  })));

  await fs.writeFile(priceOverridesPath, '{"items":[{"tampered":true}]}\n');
  await assert.rejects(
    () => loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date}),
    /Price overrides SHA-256 mismatch/,
  );
  await fs.writeFile(priceOverridesPath, '{"items":[]}\n');

  await fs.writeFile(fallbackPlanPath, `${JSON.stringify({...fallbackPlan, sourcePriceOverrides: priceOverrides.toUpperCase()})}\n`);
  await assert.rejects(
    () => loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date}),
    /declared source mismatch|price-overrides mismatch/,
  );
  await fs.writeFile(fallbackPlanPath, fallbackPlanText);

  await fs.writeFile(fallbackRescuePath, `${JSON.stringify({...fallbackRescue, sourcePriceOverrides: priceOverrides.toUpperCase()})}\n`);
  await assert.rejects(
    () => loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date}),
    /declared source mismatch|price-overrides mismatch/,
  );
  await fs.writeFile(fallbackRescuePath, fallbackRescueText);

  await fs.writeFile(fallbackRescuePath, `${JSON.stringify({...fallbackRescue, rows: [{storeKey: 'DL', skc: 'tampered'}]})}\n`);
  const tamperedFallback = await loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date});
  assert.notEqual(tamperedFallback.workFingerprint, loadedFallback.workFingerprint, 'rescue content tamper must change exact work identity');
  await fs.writeFile(fallbackRescuePath, fallbackRescueText);

  await fs.writeFile(fallbackRescuePath, `${JSON.stringify({...fallbackRescue, sourceGuard: 'outputs/reports/another.json'})}\n`);
  await assert.rejects(
    () => loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date}),
    /sourceGuard mismatch/,
  );
  await fs.writeFile(fallbackRescuePath, fallbackRescueText);

  const portableDate = '2026-08-24';
  const portablePriceOverrides = '../../../srv/shein-bi/runtime/marketing-plans/baselines/ordinary-2026-07-29-49283-49286-50003-750/price-overrides.json';
  const linuxFixtureRoot = path.join(root, 'opt', 'shein-bi', 'app');
  const exactWindowsPricePath = path.resolve(workspaceRoot, portablePriceOverrides);
  const useExactWindowsFixture = process.platform === 'win32' && await exists(exactWindowsPricePath);
  if (useExactWindowsFixture) {
    const workspaceTmpDir = path.join(workspaceRoot, 'tmp');
    await fs.mkdir(workspaceTmpDir, {recursive: true});
    portableWindowsDir = await fs.mkdtemp(path.join(workspaceTmpDir, 'marketing-repair-manifest-portable-'));
  }
  const portableRelativeDir = useExactWindowsFixture
    ? path.relative(workspaceRoot, portableWindowsDir).replaceAll(path.sep, '/')
    : `tmp/marketing-repair-manifest-portable-${process.pid}`;
  const portableGuardRelative = `${portableRelativeDir}/marketing-daily-guard-${portableDate}.json`;
  const portablePlanRelative = `${portableRelativeDir}/new-listing-7d-limited-discount-plan-${portableDate}.json`;
  const portableRescueRelative = `${portableRelativeDir}/limited-DL-new-listing-within-7d-${portableDate}.json`;
  const portableLiveScan = `${portableRelativeDir}/current-marketing-price-live-${portableDate}.json`;
  const windowsFixtureRoot = useExactWindowsFixture
    ? workspaceRoot
    : path.join(root, 'E', 'Codex WorkSpace', 'Shein销售统计');
  const portablePriceBytes = useExactWindowsFixture
    ? await fs.readFile(exactWindowsPricePath)
    : Buffer.from('portable-price-overrides\n', 'utf8');
  const portablePriceHash = sha256(portablePriceBytes);
  const portableGuard = {
    reportDate: portableDate,
    limitedDiscountTargetPriceDrift: {source: portableLiveScan},
    targetPlanSelection: {
      strategy: 'registry_current_baseline',
      priceOverrides: portablePriceOverrides,
      priceOverridesHash: portablePriceHash,
    },
  };
  const portableSourceGuard = portableGuardRelative;
  const portableRescue = {
    createdAt: '2026-08-24T00:00:00.000Z',
    storeKey: 'DL',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${portableDate}`,
    sourceGuard: portableSourceGuard,
    sourcePriceOverrides: portablePriceOverrides,
    sourcePriceOverridesSha256: portablePriceHash,
    priceOverridesSha256: portablePriceHash,
    rows: [{storeKey: 'DL', skc: 'portable-skc', limitedDiscountPrice: 20, finalTargetPrice: 20}],
  };
  const portablePlan = {
    reportDate: portableDate,
    sourceGuard: portableSourceGuard,
    sourceCurrentMarketingLiveScan: portableLiveScan,
    sourcePriceOverrides: portablePriceOverrides,
    sourcePriceOverridesSha256: portablePriceHash,
    priceOverridesSha256: portablePriceHash,
    rescueFiles: [{storeKey: 'DL', path: portableRescueRelative, count: 1}],
  };
  const portableGuardText = `${JSON.stringify(portableGuard)}\n`;
  const portableRescueText = `${JSON.stringify(portableRescue)}\n`;
  const portablePlanText = `${JSON.stringify(portablePlan)}\n`;
  const writePortableFixture = async fixtureRoot => {
    const guardPath = path.join(fixtureRoot, portableGuardRelative);
    const planPath = path.join(fixtureRoot, portablePlanRelative);
    const rescuePath = path.join(fixtureRoot, portableRescueRelative);
    const pricePath = path.resolve(fixtureRoot, portablePriceOverrides);
    await fs.mkdir(path.dirname(guardPath), {recursive: true});
    if (!(useExactWindowsFixture && fixtureRoot === windowsFixtureRoot)) {
      await fs.mkdir(path.dirname(pricePath), {recursive: true});
    }
    await fs.writeFile(guardPath, portableGuardText);
    await fs.writeFile(planPath, portablePlanText);
    await fs.writeFile(rescuePath, portableRescueText);
    if (!(useExactWindowsFixture && fixtureRoot === windowsFixtureRoot)) {
      await fs.writeFile(pricePath, portablePriceBytes);
    }
    return {guardPath, planPath, rescuePath, pricePath};
  };
  const linuxPortable = await writePortableFixture(linuxFixtureRoot);
  const windowsPortable = await writePortableFixture(windowsFixtureRoot);
  const loadedLinuxPortable = await loadExactFallbackRepairPlan({
    root: linuxFixtureRoot,
    planPath: linuxPortable.planPath,
    guardPath: linuxPortable.guardPath,
    date: portableDate,
  });
  const loadedWindowsPortable = await loadExactFallbackRepairPlan({
    root: windowsFixtureRoot,
    planPath: windowsPortable.planPath,
    guardPath: windowsPortable.guardPath,
    date: portableDate,
  });
  const portableExpectedFingerprint = sha256(JSON.stringify({
    planHash: sha256(portablePlanText),
    guard: portableSourceGuard,
    priceOverrides: [portablePriceOverrides, portablePriceHash],
    files: [[portableRescueRelative, sha256(portableRescueText)]],
  }));
  assert.equal(loadedLinuxPortable.workFingerprint, portableExpectedFingerprint);
  assert.equal(loadedWindowsPortable.workFingerprint, portableExpectedFingerprint);
  assert.equal(loadedLinuxPortable.priceOverridesRelativePath, portablePriceOverrides);
  assert.equal(loadedWindowsPortable.priceOverridesRelativePath, portablePriceOverrides);
  assert.equal(loadedLinuxPortable.entries[0].relativePath, portableRescueRelative);
  assert.equal(loadedWindowsPortable.entries[0].relativePath, portableRescueRelative);
  if (useExactWindowsFixture) {
    assert.notEqual(
      path.relative(linuxFixtureRoot, linuxPortable.pricePath).replaceAll(path.sep, '/'),
      path.relative(windowsFixtureRoot, windowsPortable.pricePath).replaceAll(path.sep, '/'),
      'host-relative price paths must differ in the regression fixture',
    );
  }

  const productionPlanPath = path.join(workspaceRoot, 'outputs', 'reports', 'new-listing-7d-limited-discount-plan-2026-08-24.json');
  const productionGuardPath = path.join(workspaceRoot, 'outputs', 'reports', 'marketing-daily-guard-2026-08-24.json');
  let productionFingerprintChecked = false;
  if (await exists(productionPlanPath) && await exists(productionGuardPath)) {
    const production = await loadExactFallbackRepairPlan({
      root: workspaceRoot,
      planPath: productionPlanPath,
      guardPath: productionGuardPath,
      date: '2026-08-24',
    });
    assert.equal(production.workFingerprint, '2bbb061dce99172b9fad16b979680ea8866a037ddd269d585790214e17120682');
    productionFingerprintChecked = true;
  }

  const manualDir = path.join(root, 'tmp', 'marketing-signup', 'manual-limited-discount-restore', date);
  await fs.mkdir(manualDir, {recursive: true});
  const manualName = 'manual-limited-restore-DL-sv3.json';
  const manualRelative = `tmp/marketing-signup/manual-limited-discount-restore/${date}/${manualName}`;
  const manualRescue = {
    storeKey: 'DL',
    purpose: 'manual_special_limited_discount_registry_restore',
    sourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv3', limitedDiscountPrice: 30}],
  };
  await fs.writeFile(path.join(manualDir, manualName), `${JSON.stringify(manualRescue)}\n`);
  const manualPlanPath = path.join(manualDir, 'manual-limited-discount-restore-plan.json');
  await fs.writeFile(manualPlanPath, `${JSON.stringify({
    reportDate: date,
    sourceGuard,
    restoreCount: 1,
    rescueFiles: [{storeKey: 'DL', skc: 'sv3', path: manualRelative}],
  })}\n`);
  const loadedManual = await loadExactManualRepairPlan({root, planPath: manualPlanPath, guardPath, date});
  assert.equal(loadedManual.entries.length, 1);
  assert.equal(loadedManual.entries[0].skc, 'sv3');
  assert.match(loadedManual.workFingerprint, /^[a-f0-9]{64}$/);

  await fs.writeFile(path.join(planDir, rescueName), `${JSON.stringify({...rescue, sourceGuard: 'outputs/reports/another.json'})}\n`);
  await assert.rejects(
    () => loadExactDriftRepairManifest({root, planDir, guardPath, date}),
    /sourceGuard mismatch/,
  );

  console.log(JSON.stringify({
    ok: true,
    manualSelectedFiles: 1,
    driftSelectedFiles: 1,
    fallbackSelectedFiles: 1,
    fallbackFingerprintPortable: true,
    fallbackTamperRejected: true,
    declaredSourceMismatchRejected: true,
    productionFingerprintChecked,
    staleGlobFilesIgnored: true,
    sourceGuardMismatchRejected: true,
    dryRunIsReadOnly: true,
    directDeletePathAbsent: true,
  }));
} finally {
  await fs.rm(root, {recursive: true, force: true});
  if (portableWindowsDir) await fs.rm(portableWindowsDir, {recursive: true, force: true});
}
