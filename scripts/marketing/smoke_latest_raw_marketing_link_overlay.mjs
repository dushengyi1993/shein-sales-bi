#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
  mergeMarketingLinkRows,
} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {
  buildExposureTopLinkIndex,
  isRecentNewListingLink,
} from '../../lib/marketing_pricing_policy.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-raw-link-overlay-'));
try {
  const storeDir = path.join(tmp, 'TS');
  await fs.mkdir(storeDir, {recursive: true});
  await fs.writeFile(path.join(storeDir, '2026-07-15.json'), JSON.stringify({
    ok: true,
    date: '2026-07-15',
    fetchTime: '2026-07-16 08:21:48',
    store: {storeKey: 'TS'},
    linkRows: [
      {
        storeKey: 'TS',
        skc: 'sv260714101779912497463',
        standardGoodsSn: 'SK-03038制冰机',
        isOnShelf: true,
        shelfStatusName: '已上架',
        firstShelfTime: '2026-07-15 21:56:01',
        hasActivity: false,
      },
      {
        storeKey: 'TS',
        skc: 'sold-out-must-not-enter-marketing-candidates',
        standardGoodsSn: 'SOLD-OUT',
        isOnShelf: false,
        shelfStatusName: '已下架',
      },
    ],
  }), 'utf8');

  const raw = collectLatestRawMarketingLinkRows({historyDir: tmp, reportDate: '2026-07-16', storeKeys: ['TS']});
  assert.equal(raw.storeCount, 1);
  assert.equal(raw.rows.length, 1);
  assert.equal(raw.rows[0].store_key, 'TS');
  assert.equal(raw.rows[0].standard_goods_sn, 'SK-03038制冰机');
  assert.equal(raw.rows[0].first_shelf_time, '2026-07-15 21:56:01');
  assert.equal(raw.rows.some(row => row.skc === 'sold-out-must-not-enter-marketing-candidates'), false);
  const rawIncludingOffShelf = collectLatestRawMarketingLinkRows({
    historyDir: tmp,
    reportDate: '2026-07-16',
    storeKeys: ['TS'],
    includeOffShelf: true,
  });
  assert.equal(rawIncludingOffShelf.rows.length, 2);
  assert.equal(rawIncludingOffShelf.rows.some(row => row.skc === 'sold-out-must-not-enter-marketing-candidates'), true);

  const existing = {
    store_key: 'TS',
    skc: 'existing',
    standard_goods_sn: 'KEEP-BI',
    c7_eps_uv: 99,
    activity_label: 'KEEP-ACTIVITY',
    platform_saleable_stock: 77,
    is_on_shelf: false,
    is_sold_out: true,
    shelf_status_name: '已售罄',
    first_shelf_time: '2026-06-01 10:00:00',
    link_date: '2026-07-15',
    current_price_source_at: '2026-07-16 08:00:00',
  };
  const merged = mergeMarketingLinkRows([existing], [
    {
      ...existing,
      standard_goods_sn: 'DO-NOT-OVERWRITE',
      c7_eps_uv: 0,
      activity_label: '',
      platform_saleable_stock: 0,
      is_on_shelf: true,
      is_sold_out: false,
      shelf_status_name: '已上架',
      first_shelf_time: '2026-07-16 12:00:00',
      link_date: '2026-07-16',
      raw_link_snapshot_fetch_time: '2026-07-16 12:05:00',
    },
    raw.rows[0],
  ]);
  assert.equal(merged.addedRowCount, 1);
  assert.equal(merged.updatedRowCount, 1);
  const updatedExisting = merged.rows.find(row => row.skc === 'existing');
  assert.equal(updatedExisting.standard_goods_sn, 'KEEP-BI');
  assert.equal(updatedExisting.c7_eps_uv, 99);
  assert.equal(updatedExisting.activity_label, 'KEEP-ACTIVITY');
  assert.equal(updatedExisting.platform_saleable_stock, 77);
  assert.equal(updatedExisting.is_on_shelf, true);
  assert.equal(updatedExisting.is_sold_out, false);
  assert.equal(updatedExisting.shelf_status_name, '已上架');
  assert.equal(updatedExisting.first_shelf_time, '2026-07-16 12:00:00');
  const unchangedOnShelf = mergeMarketingLinkRows([
    {
      store_key: 'TS',
      skc: 'already-on-shelf',
      is_on_shelf: true,
      first_shelf_time: '2026-07-15T21:56:01',
      link_date: '2026-07-15',
    },
  ], [{
    store_key: 'TS',
    skc: 'already-on-shelf',
    is_on_shelf: true,
    first_shelf_time: '2026-07-15 21:56:01',
    link_date: '2026-07-16',
    raw_link_snapshot_fetch_time: '2026-07-16 12:05:00',
  }]);
  assert.equal(unchangedOnShelf.updatedRowCount, 0);
  assert.equal(merged.rows.some(row => row.skc === 'sv260714101779912497463'), true);
  assert.equal(isRecentNewListingLink(raw.rows[0], undefined, '2026-07-16').applies, true);
  const exposure = buildExposureTopLinkIndex({
    data: {
      storeLinks: [
        {...raw.rows[0], c7_eps_uv: 123},
        {...raw.rows[0], skc: 'no-positive-metric', c7_eps_uv: 0},
      ],
    },
  });
  assert.equal(exposure.rowCount, 2);
  assert.equal(exposure.positiveMetricRowCount, 1);
  assert.equal(exposure.rankedRowCount, 1);

  const incompleteCoverage = assessLatestRawMarketingLinkCoverage({
    sourceFiles: raw.sourceFiles,
    errors: raw.errors,
    storeKeys: ['TS', 'DX'],
  });
  assert.equal(incompleteCoverage.complete, false);
  assert.deepEqual(incompleteCoverage.missingStoreKeys, ['DX']);
  const completeCoverage = assessLatestRawMarketingLinkCoverage({
    sourceFiles: [...raw.sourceFiles, {storeKey: 'DX'}],
    errors: [],
    storeKeys: ['TS', 'DX'],
  });
  assert.equal(completeCoverage.complete, true);

  console.log(JSON.stringify({
    ok: true,
    test: 'latest_raw_marketing_link_overlay_closes_bi_sidecar_race',
    addedRowCount: merged.addedRowCount,
    updatedRowCount: merged.updatedRowCount,
    protectedExistingBiRow: true,
    refreshedNewerShelfState: true,
    excludedOffShelfRawRow: true,
    incompleteCoverageFailsClosed: true,
  }));
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
