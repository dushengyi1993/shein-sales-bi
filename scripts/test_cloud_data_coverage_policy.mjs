#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {classifyMissingCoverageRows} from './audit_cloud_data_coverage.mjs';

const rows = [
  {
    date: '2026-07-23',
    missingStoreCount: 1,
    missingStores: ['HL'],
  },
  {
    date: '2026-07-24',
    missingStoreCount: 5,
    missingStores: ['CX', 'HL', 'LQ', 'NM', 'QY'],
  },
];

const automatic = classifyMissingCoverageRows({
  rows,
  allowSparseCurrentDay: true,
  currentDate: '2026-07-24',
  explicitRange: false,
});
assert.deepEqual(automatic.blockingRows.map(row => row.date), ['2026-07-23']);
assert.deepEqual(automatic.nonBlockingCurrentDayRows.map(row => row.date), ['2026-07-24']);

const explicit = classifyMissingCoverageRows({
  rows,
  allowSparseCurrentDay: true,
  currentDate: '2026-07-24',
  explicitRange: true,
});
assert.deepEqual(explicit.blockingRows.map(row => row.date), ['2026-07-23', '2026-07-24']);
assert.equal(explicit.nonBlockingCurrentDayRows.length, 0);

const watchdog = fs.readFileSync(new URL('./cloud_ops_watchdog.mjs', import.meta.url), 'utf8');
assert.match(watchdog, /'--recent-days', '2'/);

console.log('cloud_data_coverage_policy: finalized days block; current webhook day stays informational');
