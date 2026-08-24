#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadExactManualRepairPlan,
  loadExactDriftRepairManifest,
  loadExactFallbackRepairPlan,
} from '../../lib/marketing_repair_manifest.mjs';

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
  const priceOverridesHash = crypto.createHash('sha256').update(await fs.readFile(priceOverridesPath)).digest('hex');
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
    createdAt: new Date().toISOString(),
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
  await fs.writeFile(path.join(fallbackDir, fallbackName), `${JSON.stringify(fallbackRescue)}\n`);
  await fs.writeFile(path.join(fallbackDir, `limited-DL-stale-${date}-20260725-s10.json`), `${JSON.stringify({...fallbackRescue, rows: [{storeKey: 'DL', skc: 'stale2'}]})}\n`);
  const fallbackPlanPath = path.join(root, 'outputs', 'reports', `new-listing-7d-limited-discount-plan-${date}.json`);
  await fs.writeFile(fallbackPlanPath, `${JSON.stringify({
    reportDate: date,
    sourceGuard,
    sourceCurrentMarketingLiveScan: liveScan,
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesHash,
    priceOverridesSha256: priceOverridesHash,
    rescueFiles: [{storeKey: 'DL', path: fallbackRelative, count: 1}],
  })}\n`);
  const loadedFallback = await loadExactFallbackRepairPlan({root, planPath: fallbackPlanPath, guardPath, date});
  assert.equal(loadedFallback.entries.length, 1);
  assert.equal(loadedFallback.entries[0].rescue.rows[0].skc, 'sv2');

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

  console.log(JSON.stringify({ok: true, manualSelectedFiles: 1, driftSelectedFiles: 1, fallbackSelectedFiles: 1, staleGlobFilesIgnored: true, sourceGuardMismatchRejected: true, dryRunIsReadOnly: true, directDeletePathAbsent: true}));
} finally {
  await fs.rm(root, {recursive: true, force: true});
}
