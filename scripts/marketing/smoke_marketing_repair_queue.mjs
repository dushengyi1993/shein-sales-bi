#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(root, 'tmp', `marketing-repair-queue-smoke-${process.pid}`);
const date = '2026-07-18';

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function run(...args) {
  const result = spawnSync(process.execPath, ['scripts/marketing/manage_marketing_repair_queue.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function runFailure(...args) {
  const result = spawnSync(process.execPath, ['scripts/marketing/manage_marketing_repair_queue.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'overlapping exact work must fail closed');
  return result;
}

try {
  const guardPath = path.join(fixtureRoot, `marketing-daily-guard-${date}.json`);
  const driftDir = path.join(fixtureRoot, `target-price-drift-${date}`);
  const fallbackDir = path.join(fixtureRoot, `fallback-${date}`);
  const fallbackPlanPath = path.join(fixtureRoot, `new-listing-7d-limited-discount-plan-${date}.json`);
  const queuePath = path.join(fixtureRoot, `marketing-repair-${date}.json`);
  await fs.mkdir(driftDir, {recursive: true});
  await fs.mkdir(fallbackDir, {recursive: true});
  const liveScan = rel(path.join(fixtureRoot, `live-${date}.json`));
  const priceOverrides = rel(path.join(fixtureRoot, 'price-overrides.json'));
  const guard = {
    reportDate: date,
    limitedDiscountTargetPriceDrift: {
      source: liveScan,
      belowRows: [{storeKey: 'DL', skc: 'sv1'}],
    },
    manualSpecialLimitedDiscount: {actionCount: 0},
    targetPlanSelection: {priceOverrides},
  };
  await fs.writeFile(guardPath, `${JSON.stringify(guard)}\n`);
  const sourceGuard = rel(guardPath);

  const driftName = `limited-drift-rescue-DL-current-a1b2c3d4-${date}.json`;
  const driftPath = path.join(driftDir, driftName);
  await fs.writeFile(driftPath, `${JSON.stringify({
    storeKey: 'DL',
    purpose: `limited_discount_target_price_drift_rescue_${date}`,
    sourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv1'}],
  })}\n`);
  await fs.writeFile(path.join(driftDir, `limited-discount-target-drift-rescue-plan-${date}.json`), `${JSON.stringify({
    reportDate: date,
    sourceGuard,
    rescueFiles: [{storeKey: 'DL', path: rel(driftPath), count: 1}],
  })}\n`);

  const fallbackName = `limited-DL-existing-on-shelf-${date}-20260725-s10.json`;
  const fallbackPath = path.join(fallbackDir, fallbackName);
  await fs.writeFile(fallbackPath, `${JSON.stringify({
    storeKey: 'DL',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
    sourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv2'}],
  })}\n`);
  await fs.writeFile(fallbackPlanPath, `${JSON.stringify({
    reportDate: date,
    sourceGuard,
    sourceCurrentMarketingLiveScan: liveScan,
    sourcePriceOverrides: priceOverrides,
    rescueFiles: [{storeKey: 'DL', path: rel(fallbackPath), count: 1}],
  })}\n`);

  const buildArgs = ['build', '--date', date, '--guard', guardPath, '--drift-plan-dir', driftDir, '--fallback-plan', fallbackPlanPath, '--queue', queuePath];
  run(...buildArgs);
  let queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.deepEqual(queue.counts, {totalRows: 2, totalGroups: 2, manualRows: 0, manualGroups: 0, driftRows: 1, driftGroups: 1, fallbackRows: 1, fallbackGroups: 1});
  assert.equal(queue.status, 'pending');

  run('update-stage', '--queue', queuePath, '--stage', 'driftRepair', '--status', 'completed', '--readback-ok', 'true');
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.driftRepair.status, 'completed', 'same exact work fingerprint must preserve completed progress');

  await fs.writeFile(guardPath, `${JSON.stringify({...guard, createdAt: 'changed'})}\n`);
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.driftRepair.status, 'pending', 'changed guard hash must invalidate old completion');

  await fs.writeFile(fallbackPath, `${JSON.stringify({
    storeKey: 'DL',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
    sourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv1'}],
  })}\n`);
  const overlap = runFailure(...buildArgs);
  assert.match(`${overlap.stdout}\n${overlap.stderr}`, /Repair stages overlap/);

  console.log(JSON.stringify({ok: true, exactCounts: true, preservesMatchingProgress: true, invalidatesChangedGuard: true, rejectsCrossStageOverlap: true}));
} finally {
  await fs.rm(fixtureRoot, {recursive: true, force: true});
}
