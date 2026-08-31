import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {latestCurrentMarketingLiveScanFile} from './build_marketing_daily_guard_report.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-live-scan-selection-'));
try {
  const stores = Array.from({length: 19}, (_, index) => ({
    storeKey: `S${String(index + 1).padStart(2, '0')}`,
    enabled: true,
  }));
  const businessDate = '2026-08-28';
  const snapshot = ({selectedStores, ok = true, failedStoreKeys = [], createdAt, mergeEvidence}) => {
    const failed = new Set(failedStoreKeys);
    const rows = selectedStores.map(store => ({store_key: store.storeKey}));
    return {
      ok,
      partial: false,
      businessDate,
      createdAt,
      updatedAt: createdAt,
      stores: selectedStores.map(store => ({
        storeKey: store.storeKey,
        ok: !failed.has(store.storeKey),
        rows: rows.filter(row => row.store_key === store.storeKey),
      })),
      rows,
      rowCount: rows.length,
      ...(mergeEvidence ? {mergeEvidence} : {}),
    };
  };
  const select = scenarioDir => latestCurrentMarketingLiveScanFile(
    scenarioDir,
    /^current-marketing-price-live-.*\.json$/,
    {stores},
  );

  const completeScenario = path.join(dir, 'complete-then-targeted');
  await fs.mkdir(completeScenario);
  const full = path.join(completeScenario, 'current-marketing-price-live-full.json');
  const targeted = path.join(completeScenario, 'current-marketing-price-live-targeted.json');
  await fs.writeFile(full, JSON.stringify(snapshot({
    selectedStores: stores,
    createdAt: '2026-08-28T03:00:00.000Z',
  })));
  await fs.writeFile(targeted, JSON.stringify(snapshot({
    selectedStores: stores.slice(0, 4),
    createdAt: '2026-08-28T03:05:00.000Z',
  })));
  assert.equal(select(completeScenario), full, 'a newer targeted scan must not replace a successful 19-store baseline');

  const recoveryScenario = path.join(dir, 'failed-then-targeted');
  await fs.mkdir(recoveryScenario);
  const failedFull = path.join(recoveryScenario, 'current-marketing-price-live-failed-full.json');
  const recovery = path.join(recoveryScenario, 'current-marketing-price-live-targeted.json');
  await fs.writeFile(failedFull, JSON.stringify(snapshot({
    selectedStores: stores,
    ok: false,
    failedStoreKeys: stores.slice(0, 5).map(store => store.storeKey),
    createdAt: '2026-08-28T03:00:00.000Z',
  })));
  await fs.writeFile(recovery, JSON.stringify(snapshot({
    selectedStores: stores.slice(0, 5),
    createdAt: '2026-08-28T03:05:00.000Z',
  })));
  assert.equal(select(recoveryScenario), failedFull, 'a targeted recovery must not hide the failed 19-store attempt');

  const merged = path.join(recoveryScenario, 'current-marketing-price-live-merged.json');
  await fs.writeFile(merged, JSON.stringify(snapshot({
    selectedStores: stores,
    createdAt: '2026-08-28T03:10:00.000Z',
    mergeEvidence: {base: failedFull, overlays: [recovery]},
  })));
  assert.equal(select(recoveryScenario), merged, 'a newer complete merged snapshot must become authoritative');
  console.log('smoke_current_marketing_live_scan_selection: OK');
} finally {
  await fs.rm(dir, {recursive: true, force: true});
}
