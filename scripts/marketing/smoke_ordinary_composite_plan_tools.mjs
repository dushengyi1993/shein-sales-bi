#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORK = path.join(ROOT, 'tmp', `smoke-ordinary-composite-${process.pid}`);

function run(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function planRow(storeKey, activityId, skc, targetPrice) {
  return {
    storeKey,
    activityId,
    skc,
    canonical: `${storeKey}-${skc}`,
    targetPrice,
    finalTargetPrice: targetPrice,
    intendedFinalTargetPrice: targetPrice,
    cost: 50,
    fullCost: 55,
    storageUnitCostSar: 5,
    marginBeforeStorage: 0.5,
    marginAfterStorage: 0.45,
    marginForSelection: 0.45,
    selectionMarginBasis: 'full_cost_including_storage',
  };
}

function readbackRow(row) {
  return {
    storeKey: row.storeKey,
    activityId: row.activityId,
    skc: row.skc,
    expectedActivityPrice: row.targetPrice,
    finalTargetPrice: row.finalTargetPrice,
    enrolledOrUnderReview: true,
    priceOk: true,
  };
}

await fs.mkdir(WORK, {recursive: true});
try {
  const mainRows = [
    planRow('DL', 1001, 'sv-main-dl', 100.11),
    planRow('DX', 1001, 'sv-main-dx', 101.12),
  ];
  const excludedRow = {
    ...planRow('DX', 1002, 'sv-supplement-dx', 102.13),
    excludeReason: 'row_full_cost_including_storage_margin_below_floor',
    note: 'fixture',
  };
  const sourceSelection = {
    items: mainRows.map(row => ({
      storeKey: row.storeKey,
      activityId: row.activityId,
      skc: row.skc,
      selected: true,
    })),
    excluded: [{
      storeKey: excludedRow.storeKey,
      activityId: excludedRow.activityId,
      skc: excludedRow.skc,
    }],
  };
  const sourcePrices = {items: mainRows, excluded: [excludedRow]};
  const sourceReport = {
    detailRows: [{
      店铺: excludedRow.storeKey,
      活动ID: excludedRow.activityId,
      SKC: excludedRow.skc,
      商品完整成本SAR: 50,
      仓储费摊销SAR每件: 5,
      含仓储费成本SAR: 55,
    }],
  };
  // Use the exact production column name, which contains a slash.
  sourceReport.detailRows[0]['仓储费摊销SAR/件'] = sourceReport.detailRows[0].仓储费摊销SAR每件;
  delete sourceReport.detailRows[0].仓储费摊销SAR每件;

  const sourceSelectionFile = path.join(WORK, 'source-selection.json');
  const sourcePricesFile = path.join(WORK, 'source-prices.json');
  const sourceReportFile = path.join(WORK, 'source-report.json');
  await Promise.all([
    fs.writeFile(sourceSelectionFile, JSON.stringify(sourceSelection), 'utf8'),
    fs.writeFile(sourcePricesFile, JSON.stringify(sourcePrices), 'utf8'),
    fs.writeFile(sourceReportFile, JSON.stringify(sourceReport), 'utf8'),
  ]);

  const invalidPrices = structuredClone(sourcePrices);
  invalidPrices.excluded[0].excludeReason = 'missing_cost';
  const invalidPricesFile = path.join(WORK, 'invalid-prices.json');
  await fs.writeFile(invalidPricesFile, JSON.stringify(invalidPrices), 'utf8');
  const invalidSupplement = run('scripts/marketing/build_ordinary_excluded_rows_supplement.mjs', [
    '--source-selection', sourceSelectionFile,
    '--source-prices', invalidPricesFile,
    '--source-report', sourceReportFile,
    '--output-dir', path.join(WORK, 'invalid-supplement'),
    '--label', 'invalid',
    '--approval-text', 'fixture approval',
  ]);
  assert.notEqual(invalidSupplement.status, 0, 'non-margin exclusion must fail closed');

  const supplementDir = path.join(WORK, 'supplement');
  const supplement = run('scripts/marketing/build_ordinary_excluded_rows_supplement.mjs', [
    '--source-selection', sourceSelectionFile,
    '--source-prices', sourcePricesFile,
    '--source-report', sourceReportFile,
    '--output-dir', supplementDir,
    '--label', 'valid',
    '--approval-text', 'fixture approval',
  ]);
  assert.equal(supplement.status, 0, supplement.stderr || supplement.stdout);

  const mainSelectionFile = path.join(WORK, 'main-selection.json');
  const mainPricesFile = path.join(WORK, 'main-prices.json');
  await Promise.all([
    fs.writeFile(mainSelectionFile, JSON.stringify({
      items: mainRows.map(row => ({
        storeKey: row.storeKey,
        activityId: row.activityId,
        skc: row.skc,
        selected: true,
      })),
    }), 'utf8'),
    fs.writeFile(mainPricesFile, JSON.stringify({items: mainRows}), 'utf8'),
  ]);

  const mergedDir = path.join(WORK, 'merged');
  const mergedPlan = run('scripts/marketing/merge_ordinary_campaign_plans.mjs', [
    '--selection', mainSelectionFile,
    '--prices', mainPricesFile,
    '--selection', path.join(supplementDir, 'selection-plan-valid.json'),
    '--prices', path.join(supplementDir, 'price-overrides-valid.json'),
    '--output-dir', mergedDir,
    '--label', 'all',
  ]);
  assert.equal(mergedPlan.status, 0, mergedPlan.stderr || mergedPlan.stdout);
  const mergedSelectionFile = path.join(mergedDir, 'selection-plan-all.json');
  const mergedPricesFile = path.join(mergedDir, 'price-overrides-all.json');
  const mergedPrices = JSON.parse(await fs.readFile(mergedPricesFile, 'utf8'));
  assert.equal(mergedPrices.items.length, 3);

  const baseReadback = {
    summary: {stores: ['DL', 'DX'], plannedRows: 2, checkedRows: 2},
    stores: [
      {storeKey: 'DL', ok: true, rows: [readbackRow(mainRows[0])], activities: []},
      {storeKey: 'DX', ok: true, rows: [readbackRow(mainRows[1])], activities: []},
    ],
  };
  const patchReadback = {
    summary: {
      selectionPlan: mergedSelectionFile,
      priceOverrides: mergedPricesFile,
    },
    stores: [{
      storeKey: 'DX',
      ok: true,
      rows: [readbackRow(mainRows[1]), readbackRow(excludedRow)],
      activities: [],
    }],
  };
  const baseReadbackFile = path.join(WORK, 'base-readback.json');
  const patchReadbackFile = path.join(WORK, 'patch-readback.json');
  await Promise.all([
    fs.writeFile(baseReadbackFile, JSON.stringify(baseReadback), 'utf8'),
    fs.writeFile(patchReadbackFile, JSON.stringify(patchReadback), 'utf8'),
  ]);
  const mergedReadbackFile = path.join(WORK, 'merged-readback.json');
  const mergedReadback = run('scripts/marketing/merge_ordinary_activity_enrollment_reports.mjs', [
    '--base', baseReadbackFile,
    '--patches', patchReadbackFile,
    '--out', mergedReadbackFile,
  ]);
  assert.equal(mergedReadback.status, 0, mergedReadback.stderr || mergedReadback.stdout);
  const mergedReadbackDoc = JSON.parse(await fs.readFile(mergedReadbackFile, 'utf8'));
  assert.equal(mergedReadbackDoc.summary.plannedRows, 3);
  assert.equal(mergedReadbackDoc.summary.checkedRows, 3);
  assert.equal(mergedReadbackDoc.summary.planAlignment.ok, true);

  const incompletePatch = structuredClone(patchReadback);
  incompletePatch.stores[0].rows.pop();
  const incompletePatchFile = path.join(WORK, 'incomplete-patch.json');
  await fs.writeFile(incompletePatchFile, JSON.stringify(incompletePatch), 'utf8');
  const incompleteMerge = run('scripts/marketing/merge_ordinary_activity_enrollment_reports.mjs', [
    '--base', baseReadbackFile,
    '--patches', incompletePatchFile,
    '--out', path.join(WORK, 'must-not-exist.json'),
  ]);
  assert.notEqual(incompleteMerge.status, 0, 'readback missing an approved row must fail closed');

  console.log(JSON.stringify({
    ok: true,
    test: 'ordinary_composite_plan_tools_fail_closed',
    mergedRows: 3,
  }));
} finally {
  await fs.rm(WORK, {recursive: true, force: true});
}
