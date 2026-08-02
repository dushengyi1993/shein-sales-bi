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

const afterMidnightBeforeFinalizer = classifyMissingCoverageRows({
  rows: [
    {date: '2026-08-02', missingStoreCount: 1, missingStores: ['TZ']},
    {date: '2026-08-03', missingStoreCount: 2, missingStores: ['TZ', 'DL']},
  ],
  allowSparseCurrentDay: true,
  currentDate: '2026-08-03',
  currentHour: 0,
  finalizationGraceHours: 4,
  explicitRange: false,
});
assert.deepEqual(afterMidnightBeforeFinalizer.blockingRows, []);
assert.deepEqual(
  afterMidnightBeforeFinalizer.nonBlockingCurrentDayRows.map(row => row.date),
  ['2026-08-02', '2026-08-03'],
);

const afterFinalizerDeadline = classifyMissingCoverageRows({
  rows: [
    {date: '2026-08-02', missingStoreCount: 1, missingStores: ['TZ']},
    {date: '2026-08-03', missingStoreCount: 2, missingStores: ['TZ', 'DL']},
  ],
  allowSparseCurrentDay: true,
  currentDate: '2026-08-03',
  currentHour: 4,
  finalizationGraceHours: 4,
  explicitRange: false,
});
assert.deepEqual(afterFinalizerDeadline.blockingRows.map(row => row.date), ['2026-08-02']);
assert.deepEqual(afterFinalizerDeadline.nonBlockingCurrentDayRows.map(row => row.date), ['2026-08-03']);

const watchdog = fs.readFileSync(new URL('./cloud_ops_watchdog.mjs', import.meta.url), 'utf8');
assert.match(watchdog, /SHEIN_CLOUD_WATCHDOG_FINALIZED_SALES_SLA_MINUTE/);
assert.match(watchdog, /'--recent-days', String\(recentDays\)/);

console.log('cloud_data_coverage_policy: finalized days block; current webhook day stays informational');
