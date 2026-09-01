#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoot = path.join(root, 'tmp', `marketing-repair-queue-smoke-${process.pid}`);
const overlapRoot = path.join(root, 'tmp', `marketing-repair-queue-overlap-smoke-${process.pid}`);
const date = '2026-07-18';

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

async function expectedQueueCas(queuePath) {
  const bytes = await fs.readFile(queuePath);
  const queue = JSON.parse(bytes.toString('utf8'));
  return [
    '--expected-queue-fingerprint', queue.queueFingerprint,
    '--expected-source-guard-hash', queue.sourceGuardHash,
    '--expected-queue-state-sha256', sha256(bytes),
  ];
}

try {
  const guardPath = path.join(fixtureRoot, `marketing-daily-guard-${date}.json`);
  const driftDir = path.join(fixtureRoot, `target-price-drift-${date}`);
  const fallbackDir = path.join(fixtureRoot, `fallback-${date}`);
  const fallbackPlanPath = path.join(fixtureRoot, `new-listing-7d-limited-discount-plan-${date}.json`);
  const highClickPlanPath = path.join(fixtureRoot, `high-click-low-conversion-special-plan-${date}.json`);
  const queuePath = path.join(fixtureRoot, `marketing-repair-${date}.json`);
  await fs.mkdir(driftDir, {recursive: true});
  await fs.mkdir(fallbackDir, {recursive: true});
  const liveScan = rel(path.join(fixtureRoot, `live-${date}.json`));
  const priceOverridesPath = path.join(fixtureRoot, 'price-overrides.json');
  const priceOverrides = rel(priceOverridesPath);
  const priceOverridesText = `${JSON.stringify({items: []})}\n`;
  await fs.writeFile(priceOverridesPath, priceOverridesText);
  const priceOverridesSha256 = sha256(priceOverridesText);
  let guard = {
    reportDate: date,
    highClickLowConversionSpecial: {
      actionCount: 1,
      rows: [{storeKey: 'HL', skc: 'sv3'}],
    },
    limitedDiscountTargetPriceDrift: {
      source: liveScan,
      belowRows: [{storeKey: 'DL', skc: 'sv1'}],
    },
    manualSpecialLimitedDiscount: {actionCount: 0},
    targetPlanSelection: {priceOverrides, priceOverridesHash: priceOverridesSha256},
  };
  const writeGuardAndHighClickPlan = async () => {
    const guardText = `${JSON.stringify(guard)}\n`;
    await fs.writeFile(guardPath, guardText);
    await fs.writeFile(highClickPlanPath, `${JSON.stringify({
      reportDate: date,
      sourceGuard: rel(guardPath),
      sourceGuardHash: crypto.createHash('sha256').update(guardText).digest('hex'),
      actionCount: 1,
      rows: [{
        storeKey: 'HL',
        skc: 'sv3',
        canonical: 'SK-3',
        specialPrice: 88.88,
        activityStock: 10,
        validFrom: `${date} 12:00:00`,
        validTo: '2026-07-25 23:59:59',
      }],
    })}\n`);
  };
  await writeGuardAndHighClickPlan();
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
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesSha256,
    priceOverridesSha256,
    rows: [{storeKey: 'DL', skc: 'sv2'}],
  })}\n`);
  await fs.writeFile(fallbackPlanPath, `${JSON.stringify({
    reportDate: date,
    sourceGuard,
    sourceCurrentMarketingLiveScan: liveScan,
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesSha256,
    priceOverridesSha256,
    rescueFiles: [{storeKey: 'DL', path: rel(fallbackPath), count: 1}],
  })}\n`);

  const buildArgs = ['build', '--date', date, '--guard', guardPath, '--high-click-plan', highClickPlanPath, '--drift-plan-dir', driftDir, '--fallback-plan', fallbackPlanPath, '--queue', queuePath];
  run(...buildArgs);
  let queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.deepEqual(queue.counts, {
    totalRows: 3,
    totalGroups: 3,
    highClickRows: 1,
    highClickGroups: 1,
    manualRows: 0,
    manualGroups: 0,
    driftRows: 1,
    driftGroups: 1,
    driftRawRows: 1,
    driftRowsHandledByHighClickSpecial: 0,
    driftKeysHandledByHighClickSpecial: [],
    fallbackRows: 1,
    fallbackGroups: 1,
  });
  assert.equal(queue.status, 'pending');

  run('update-stage', '--queue', queuePath, '--stage', 'highClickSpecial', '--status', 'completed', '--readback-ok', 'true', ...await expectedQueueCas(queuePath));
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  run('update-stage', '--queue', queuePath, '--stage', 'driftRepair', '--status', 'completed', '--readback-ok', 'true', ...await expectedQueueCas(queuePath));
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.driftRepair.status, 'completed', 'same exact work fingerprint must preserve completed progress');

  run('update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'partial', '--readback-ok', 'false', '--detail', 'processed one group before browser lease loss', '--result-path', 'tmp/results/fallback-partial.json', ...await expectedQueueCas(queuePath));
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  queue.stages.fallbackRepair.checkpoint = {lastGroup: 'DL', remainingGroups: 1};
  queue.stages.fallbackRepair.successfulTuples = ['DL::sv2'];
  await fs.writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.fallbackRepair.status, 'pending', 'same exact partial stage must automatically reopen so cloud workers can continue it');
  assert.equal(queue.status, 'pending', 'partial recovery must remain worker-consumable instead of failing the whole queue');
  assert.equal(queue.stages.fallbackRepair.previousPartial.detail, 'processed one group before browser lease loss');
  assert.equal(queue.stages.fallbackRepair.previousPartial.resultPath, 'tmp/results/fallback-partial.json');
  assert.deepEqual(queue.stages.fallbackRepair.previousPartial.checkpoint, {lastGroup: 'DL', remainingGroups: 1});
  assert.deepEqual(queue.stages.fallbackRepair.previousPartial.successfulTuples, ['DL::sv2']);
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.fallbackRepair.status, 'pending', 'operator can continue the same business day after rebuilding/filling partial evidence');
  assert.equal(queue.stages.driftRepair.status, 'completed', 'previously completed exact stages must not replay when partial is reopened');
  assert.deepEqual(queue.stages.fallbackRepair.previousPartial.successfulTuples, ['DL::sv2'], 'partial success tuple audit must survive repeated queue rebuilds until worker consumes pending stage');
  assert.equal(queue.status, 'pending');

  run('update-stage', '--queue', queuePath, '--stage', 'fallbackRepair', '--status', 'blocked', '--readback-ok', 'false', ...await expectedQueueCas(queuePath));
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.fallbackRepair.status, 'blocked', 'same exact work fingerprint must preserve terminal business blockers');
  assert.equal(queue.status, 'blocked', 'a fully processed queue with business blockers must not remain pending');

  guard = {...guard, createdAt: 'changed'};
  await writeGuardAndHighClickPlan();
  run(...buildArgs);
  queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.stages.driftRepair.status, 'pending', 'changed guard hash must invalidate old completion');

  await fs.writeFile(fallbackPath, `${JSON.stringify({
    storeKey: 'DL',
    purpose: `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`,
    sourceGuard,
    sourcePriceOverrides: priceOverrides,
    sourcePriceOverridesSha256: priceOverridesSha256,
    priceOverridesSha256,
    rows: [{storeKey: 'DL', skc: 'sv1'}],
  })}\n`);
  const overlap = runFailure(...buildArgs);
  assert.match(`${overlap.stdout}\n${overlap.stderr}`, /Repair stages overlap/);

  const overlapDate = '2026-07-19';
  const overlapGuardPath = path.join(overlapRoot, `marketing-daily-guard-${overlapDate}.json`);
  const overlapDriftDir = path.join(overlapRoot, `target-price-drift-${overlapDate}`);
  const overlapHighClickPlanPath = path.join(overlapRoot, `high-click-low-conversion-special-plan-${overlapDate}.json`);
  const overlapFallbackPlanPath = path.join(overlapRoot, `new-listing-7d-limited-discount-plan-${overlapDate}.json`);
  const overlapQueuePath = path.join(overlapRoot, `marketing-repair-${overlapDate}.json`);
  await fs.mkdir(overlapDriftDir, {recursive: true});
  const overlapLiveScan = rel(path.join(overlapRoot, `live-${overlapDate}.json`));
  const overlapPriceOverridesPath = path.join(overlapRoot, 'price-overrides.json');
  const overlapPriceOverrides = rel(overlapPriceOverridesPath);
  const overlapPriceOverridesText = `${JSON.stringify({items: []})}\n`;
  await fs.writeFile(overlapPriceOverridesPath, overlapPriceOverridesText);
  const overlapPriceOverridesSha256 = sha256(overlapPriceOverridesText);
  const overlapGuard = {
    reportDate: overlapDate,
    highClickLowConversionSpecial: {
      actionCount: 1,
      rows: [{storeKey: 'DL', skc: 'sv-overlap'}],
    },
    limitedDiscountTargetPriceDrift: {
      source: overlapLiveScan,
      belowRows: [
        {storeKey: 'DL', skc: 'sv-overlap'},
        {storeKey: 'DL', skc: 'sv-overlap'},
      ],
    },
    manualSpecialLimitedDiscount: {actionCount: 0},
    targetPlanSelection: {
      priceOverrides: overlapPriceOverrides,
      priceOverridesHash: overlapPriceOverridesSha256,
    },
  };
  const overlapGuardText = `${JSON.stringify(overlapGuard)}\n`;
  await fs.writeFile(overlapGuardPath, overlapGuardText);
  await fs.writeFile(overlapHighClickPlanPath, `${JSON.stringify({
    reportDate: overlapDate,
    sourceGuard: rel(overlapGuardPath),
    sourceGuardHash: crypto.createHash('sha256').update(overlapGuardText).digest('hex'),
    actionCount: 1,
    rows: [{
      storeKey: 'DL',
      skc: 'sv-overlap',
      canonical: 'SK-OVL',
      specialPrice: 88.88,
      activityStock: 10,
      validFrom: `${overlapDate} 12:00:00`,
      validTo: '2026-07-26 23:59:59',
    }],
  })}\n`);
  const overlapSourceGuard = rel(overlapGuardPath);
  await fs.writeFile(path.join(overlapDriftDir, `limited-discount-target-drift-rescue-plan-${overlapDate}.json`), `${JSON.stringify({
    reportDate: overlapDate,
    sourceGuard: overlapSourceGuard,
    rescueFiles: [],
  })}\n`);
  await fs.writeFile(overlapFallbackPlanPath, `${JSON.stringify({
    reportDate: overlapDate,
    sourceGuard: overlapSourceGuard,
    sourceCurrentMarketingLiveScan: overlapLiveScan,
    sourcePriceOverrides: overlapPriceOverrides,
    sourcePriceOverridesSha256: overlapPriceOverridesSha256,
    priceOverridesSha256: overlapPriceOverridesSha256,
    rescueFiles: [],
  })}\n`);
  const overlapBuildArgs = ['build', '--date', overlapDate, '--guard', overlapGuardPath, '--high-click-plan', overlapHighClickPlanPath, '--drift-plan-dir', overlapDriftDir, '--fallback-plan', overlapFallbackPlanPath, '--queue', overlapQueuePath];
  run(...overlapBuildArgs);
  const overlapQueue = JSON.parse(await fs.readFile(overlapQueuePath, 'utf8'));
  assert.equal(overlapQueue.counts.driftRows, 0);
  assert.equal(overlapQueue.counts.driftRawRows, 2);
  assert.equal(overlapQueue.counts.driftRowsHandledByHighClickSpecial, 1);
  assert.deepEqual(overlapQueue.counts.driftKeysHandledByHighClickSpecial, ['DL::sv-overlap']);
  assert.deepEqual(overlapQueue.deduplication.highClickPriorityExcludedDriftKeys, ['DL::sv-overlap']);
  assert.equal(overlapQueue.stages.driftRepair.status, 'not_required');
  assert.equal(overlapQueue.stages.driftRepair.rows, 0);
  assert.equal(overlapQueue.stages.highClickSpecial.status, 'pending');
  assert.equal(overlapQueue.counts.totalRows, 1);

  const staleRescueName = `limited-drift-rescue-DL-stale-ffffffff-${overlapDate}.json`;
  await fs.writeFile(path.join(overlapDriftDir, staleRescueName), `${JSON.stringify({
    storeKey: 'DL',
    purpose: `limited_discount_target_price_drift_rescue_${overlapDate}`,
    sourceGuard: overlapSourceGuard,
    rows: [{storeKey: 'DL', skc: 'sv-overlap'}],
  })}\n`);
  await fs.writeFile(path.join(overlapDriftDir, `limited-discount-target-drift-rescue-plan-${overlapDate}.json`), `${JSON.stringify({
    reportDate: overlapDate,
    sourceGuard: overlapSourceGuard,
    rescueFiles: [{storeKey: 'DL', path: rel(path.join(overlapDriftDir, staleRescueName)), count: 1}],
  })}\n`);
  const staleOverlapFailure = runFailure(...overlapBuildArgs);
  assert.match(`${staleOverlapFailure.stdout}\n${staleOverlapFailure.stderr}`, /Drift queue row mismatch/);

  console.log(JSON.stringify({
    ok: true,
    exactCounts: true,
    preservesMatchingProgress: true,
    invalidatesChangedGuard: true,
    rejectsCrossStageOverlap: true,
    explainsHighClickDriftOverlap: true,
    rejectsStaleUnexplainedDriftManifest: true,
  }));
} finally {
  await fs.rm(fixtureRoot, {recursive: true, force: true});
  await fs.rm(overlapRoot, {recursive: true, force: true});
}
