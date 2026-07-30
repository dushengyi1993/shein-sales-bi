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
  const full = path.join(dir, 'current-marketing-price-live-full.json');
  const targeted = path.join(dir, 'current-marketing-price-live-targeted.json');
  await fs.writeFile(full, JSON.stringify({
    ok: true,
    partial: false,
    rows: stores.map(store => ({store_key: store.storeKey})),
  }));
  await fs.writeFile(targeted, JSON.stringify({
    ok: true,
    partial: false,
    rows: stores.slice(0, 4).map(store => ({store_key: store.storeKey})),
  }));
  const now = new Date();
  await fs.utimes(full, new Date(now.getTime() - 2_000), new Date(now.getTime() - 2_000));
  await fs.utimes(targeted, now, now);

  assert.equal(
    latestCurrentMarketingLiveScanFile(dir, /^current-marketing-price-live-.*\.json$/, {stores}),
    full,
    'a newer targeted scan must not replace the complete 19-store baseline',
  );
  console.log('smoke_current_marketing_live_scan_selection: OK');
} finally {
  await fs.rm(dir, {recursive: true, force: true});
}
