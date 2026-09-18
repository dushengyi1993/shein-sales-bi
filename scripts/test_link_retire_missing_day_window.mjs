#!/usr/bin/env node
// The 16-day protection window (start = runDate - 15, cutoff = runDate - 14)
// needs one observation per day. 2026-09-05 has NO observation in any source:
// the old cloud's per-day link documents cover 2026-08-13..09-04 and
// 09-06..09-14 (09-05 is absent), the migrated host matches, and
// fact.visible_inventory_snapshot is missing that day on both hosts. The
// 2026-09-06 morning-all marker is failed with businessDate 09-05 (deadline
// expired), i.e. the chain produced no artifact that day.
//
// Decision (2026-09-18): accept self-healing. A missing day must keep the row
// in cannotJudge while it is inside the window, because bridging the gap from a
// neighbouring day could hide a genuine 09-04 -> 09-05 sellout -> 09-06 restock
// recovery and silently release a link that is still inside its protection
// line. The gap leaves the window by arithmetic, so the rows converge on their
// own with no new inference. This test pins both halves: the window math (which
// dates are in scope, and when 2026-09-05 leaves it) and the fail-closed
// behaviour for a missing in-window day.
import assert from 'node:assert/strict';

import {classifyEvidence, sha, shiftDate, STORES} from '../lib/link_retire_review_evidence.mjs';

const runDate = '2026-09-18';
const performanceDate = '2026-09-17';
const querySha256 = sha('retention-window-fixture');
const GAP_DATE = '2026-09-05';

// The window is [runDate - 15, runDate] inclusive: 16 days, one of which is the
// run day itself, and the cutoff (runDate - 14) only needs the preceding
// observation to spot a first-protected-day recovery.
function windowDates(forRunDate) {
  const start = shiftDate(forRunDate, -15);
  return Array.from({length: 16}, (_, index) => shiftDate(start, index));
}

const currentWindow = windowDates(runDate);
assert.equal(currentWindow.length, 16, 'the protection window is 16 days including the run day');
assert.equal(currentWindow[0], '2026-09-03', 'the current window starts at runDate - 15');
assert.equal(currentWindow.at(-1), runDate, 'the window ends on the run day');
assert.ok(currentWindow.includes(GAP_DATE), 'the 2026-09-05 gap is inside the current window');
assert.equal(shiftDate(runDate, -14), '2026-09-04', 'the recovery cutoff is runDate - 14');

// Self-healing is arithmetic: the gap leaves the window on the first run date
// whose start is later than the gap. start > GAP_DATE <=> runDate > GAP_DATE+15.
const gapExitRunDate = shiftDate(GAP_DATE, 16);
assert.equal(gapExitRunDate, '2026-09-21', '2026-09-05 leaves the window on runDate 2026-09-21');
for (const probe of ['2026-09-19', '2026-09-20']) {
  assert.ok(windowDates(probe).includes(GAP_DATE), `runDate ${probe} still includes the gap`);
}
for (const probe of ['2026-09-21', '2026-09-22']) {
  assert.ok(!windowDates(probe).includes(GAP_DATE), `runDate ${probe} no longer includes the gap`);
}
assert.ok(!windowDates('2026-09-21').includes('2026-09-04'), 'the day before the gap also leaves the window on 2026-09-21');

// Fail-closed behaviour: a row whose only blocker is a missing in-window day
// must stay cannotJudge, and the issue must name that exact date.
function rowWithGap({gapDate = GAP_DATE} = {}) {
  const dates = windowDates(runDate);
  const inventory = dates.filter(date => date !== gapDate).map(date => ({date, usable: 10}));
  const statusHistory = dates.filter(date => date !== gapDate).map(date => ({date, isOnShelf: true}));
  return {
    store_key: STORES[0],
    skc: 'sv-gap-fixture',
    performance: {found: true, date: performanceDate, newTagPresent: true, newTag: '', sales7: 0, exposure7: 100},
    openapiCount: 1,
    openapi: {found: true, spu: 'spu-gap', status: '已上架', firstShelf: '2026-01-01', lastShelf: '2026-01-01', fetchedAt: runDate, inventory: 10},
    inventory,
    statusHistory,
    historyIssues: [`unavailable:${gapDate}`],
    marketing: {covered: true, source: 'scan.json', sourceAt: runDate, matches: []},
  };
}

function evidenceFor(row) {
  return {
    schemaVersion: 'link-retire-evidence/v1',
    host: 'shein-bi-fnos',
    runDate,
    performanceDate,
    querySha256,
    generatedAt: `${runDate}T05:00:00Z`,
    sources: [],
    rows: [row],
  };
}

const poolRow = {store_key: STORES[0], skc: 'sv-gap-fixture', spu: 'spu-gap', is_on_shelf: true, c7_eps_uv: 100, c7_sale_cnt: 0};
const pool = [poolRow];

const gapRow = rowWithGap();
const gapResult = classifyEvidence(pool, evidenceFor(gapRow), {runDate, performanceDate, querySha256})[0];
assert.equal(gapResult.retire_candidate_bucket, 'cannotJudge',
  'a missing in-window day must fail closed, not be bridged from a neighbour');
assert.ok(gapResult.evidence_issues.includes('status_history_incomplete'), 'the gap must surface as an incomplete-history issue');
assert.ok(gapResult.evidence_issues.includes(`unavailable:${GAP_DATE}`) || gapResult.evidence_issues.some(i => String(i).includes(GAP_DATE)),
  'the blocker must name the exact missing date');
assert.equal(gapResult.recovery_evidence_complete, false, 'the recovery window is not proven while a day is missing');
assert.deepEqual(gapResult.missing_status_dates, [GAP_DATE], 'the missing status date must be reported exactly');
assert.ok(gapResult.missing_inventory_dates.includes(GAP_DATE), 'the missing inventory date must be reported exactly');

// Counter-example: the same row with no missing day is a clean candidate, so the
// cannotJudge above is caused by the gap alone and not by the fixture shape.
const completeRow = rowWithGap({gapDate: null});
completeRow.historyIssues = [];
const completeResult = classifyEvidence(pool, evidenceFor(completeRow), {runDate, performanceDate, querySha256})[0];
assert.equal(completeResult.retire_candidate_bucket, 'candidate',
  'the identical row without the gap must be a candidate, isolating the gap as the only blocker');
assert.equal(completeResult.recovery_evidence_complete, true);

// Bridging is explicitly NOT implemented: an observation copied from the day
// before the gap must not make the row look complete, otherwise a 09-04 ->
// 09-05 sellout -> 09-06 restock would be misread as a plain recovery.
const bridged = rowWithGap();
bridged.inventory.push({date: GAP_DATE, usable: 10, bridgedFrom: '2026-09-04'});
bridged.statusHistory.push({date: GAP_DATE, isOnShelf: true, bridgedFrom: '2026-09-04'});
const bridgedResult = classifyEvidence(pool, evidenceFor(bridged), {runDate, performanceDate, querySha256})[0];
assert.equal(bridgedResult.retire_candidate_bucket, 'cannotJudge',
  'a duplicated neighbour observation must not be accepted as the missing day');
assert.ok(bridgedResult.evidence_issues.includes(`unavailable:${GAP_DATE}`),
  'the gap must stay reported even when a neighbour value was copied in');

console.log(JSON.stringify({
  ok: true,
  test: 'link_retire_missing_day_window_contract',
  gapDate: GAP_DATE,
  windowStart: currentWindow[0],
  gapExitRunDate,
  checks: [
    'window_is_16_days_inclusive',
    'gap_inside_current_window',
    'gap_leaves_window_on_2026_09_21',
    'missing_in_window_day_fails_closed',
    'complete_row_without_gap_is_candidate',
    'bridging_is_not_accepted',
  ],
}));
