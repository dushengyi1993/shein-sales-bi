#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {assessTerminalReportReadiness} from './check_marketing_terminal_report_readiness.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'marketing-terminal-ready-'));
await fs.writeFile(path.join(root, 'drift.json'), JSON.stringify({
  rows: [{storeKey: 'DX', skc: 'drift-1'}],
}));

const guard = {
  highClickLowConversionSpecial: {actionCount: 1},
  manualSpecialLimitedDiscount: {actionCount: 0},
  limitedDiscountTargetPriceDrift: {belowRows: [{storeKey: 'DX', skc: 'drift-1'}]},
};
const plans = {
  highClickPlan: {rows: [{storeKey: 'YJ', skc: 'high-1'}]},
  driftPlan: {groups: [{rows: [{storeKey: 'DX', skc: 'drift-1'}]}]},
  fallbackPlan: {rows: [
    {storeKey: 'DL', skc: 'fallback-blocked'},
    {storeKey: 'CX', skc: 'fallback-new'},
  ]},
};
const results = {
  driftResult: {results: [{
    storeKey: 'DX',
    status: 'inventory_transaction_or_enrollment_blocked',
    rescuePath: 'drift.json',
  }]},
  fallbackResult: {results: [{
    storeKey: 'DL',
    status: 'platform_or_inventory_blocked',
    blocked: {blockedSkcs: ['fallback-blocked']},
  }]},
};

let checks = 0;
const pending = await assessTerminalReportReadiness({guard, ...plans, ...results, root});
assert.equal(pending.ready, false); checks += 1;
assert.deepEqual(pending.stages.highClickSpecial.unhandledKeys, ['YJ::high-1']); checks += 1;
assert.deepEqual(pending.stages.fallbackRepair.unhandledKeys, ['CX::fallback-new']); checks += 1;
assert.equal(pending.stages.driftRepair.unhandledCount, 0); checks += 1;

const executedStillPlanned = await assessTerminalReportReadiness({
  guard: {...guard, highClickLowConversionSpecial: {actionCount: 0}},
  ...plans,
  ...results,
  fallbackResult: {results: [{
    storeKey: 'CX',
    status: 'executed',
    ok: true,
    targetSkcs: ['fallback-new'],
  }]},
  root,
});
assert.equal(executedStillPlanned.ready, false); checks += 1;
assert.deepEqual(executedStillPlanned.stages.fallbackRepair.unhandledKeys.sort(), [
  'CX::fallback-new',
  'DL::fallback-blocked',
]); checks += 1;

const ready = await assessTerminalReportReadiness({
  guard: {...guard, highClickLowConversionSpecial: {actionCount: 0}},
  ...plans,
  ...results,
  fallbackResult: {results: [
    {storeKey: 'DL', status: 'platform_or_inventory_blocked', blocked: {blockedSkcs: ['fallback-blocked']}},
    {storeKey: 'CX', status: 'platform_or_inventory_blocked', blocked: {blockedSkcs: ['fallback-new']}},
  ]},
  root,
});
assert.equal(ready.ready, true); checks += 1;
assert.equal(ready.unhandledCount, 0); checks += 1;

// All non-high-click stages fully accounted, so only the high-click stage
// decides readiness in the scenarios below.
const otherStagesAccounted = {
  guard: {...guard, highClickLowConversionSpecial: {actionCount: 1}},
  highClickPlan: {rows: [{storeKey: 'YJ', skc: 'high-1'}]},
  driftPlan: plans.driftPlan,
  fallbackPlan: plans.fallbackPlan,
  driftResult: results.driftResult,
  fallbackResult: {results: [
    {storeKey: 'DL', status: 'platform_or_inventory_blocked', blocked: {blockedSkcs: ['fallback-blocked']}},
    {storeKey: 'CX', status: 'platform_or_inventory_blocked', blocked: {blockedSkcs: ['fallback-new']}},
  ]},
};

// Real-time re-check safe skip: no_longer_qualifies + ok=true is terminal.
const highClickSkipped = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'no_longer_qualifies', ok: true},
  ]},
  root,
});
assert.equal(highClickSkipped.ready, true); checks += 1;
assert.equal(highClickSkipped.stages.highClickSpecial.unhandledCount, 0); checks += 1;

// Compatible manual terminal-state copy: blocked_no_longer_qualifies + ok=true
// is terminal in the high-click stage.
const highClickBlockedSkipped = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'blocked_no_longer_qualifies', ok: true},
  ]},
  root,
});
assert.equal(highClickBlockedSkipped.ready, true); checks += 1;
assert.equal(highClickBlockedSkipped.stages.highClickSpecial.unhandledCount, 0); checks += 1;

// The compatible status name belongs only to high-click qualification
// revalidation; it must not relax the manual-special stage.
const manualCopySkipped = await assessTerminalReportReadiness({
  guard: {...guard, highClickLowConversionSpecial: {actionCount: 0}, manualSpecialLimitedDiscount: {actionCount: 1}},
  highClickPlan: {rows: []},
  manualPlan: {rows: [{storeKey: 'NM', skc: 'manual-1'}]},
  driftPlan: plans.driftPlan,
  fallbackPlan: plans.fallbackPlan,
  driftResult: results.driftResult,
  fallbackResult: otherStagesAccounted.fallbackResult,
  manualResult: {results: [
    {storeKey: 'NM', skc: 'manual-1', status: 'blocked_no_longer_qualifies', ok: true},
  ]},
  root,
});
assert.equal(manualCopySkipped.ready, false); checks += 1;
assert.deepEqual(manualCopySkipped.stages.manualSpecialRestore.unhandledKeys, ['NM::manual-1']); checks += 1;

// no_longer_qualifies without explicit success is not terminal evidence.
const skippedNotOk = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'no_longer_qualifies', ok: false},
  ]},
  root,
});
assert.equal(skippedNotOk.ready, false); checks += 1;
assert.deepEqual(skippedNotOk.stages.highClickSpecial.unhandledKeys, ['YJ::high-1']); checks += 1;

// blocked_no_longer_qualifies without explicit success must not be counted by
// its `blocked` prefix.
const blockedSkippedNotOk = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'blocked_no_longer_qualifies', ok: false},
  ]},
  root,
});
assert.equal(blockedSkippedNotOk.ready, false); checks += 1;
assert.deepEqual(blockedSkippedNotOk.stages.highClickSpecial.unhandledKeys, ['YJ::high-1']); checks += 1;

// A plain failure is never terminal evidence.
const failed = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'failed', ok: false},
  ]},
  root,
});
assert.equal(failed.ready, false); checks += 1;
assert.deepEqual(failed.stages.highClickSpecial.unhandledKeys, ['YJ::high-1']); checks += 1;

// An unknown status is never terminal evidence, even with ok=true.
const unknown = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'mystery_state', ok: true},
  ]},
  root,
});
assert.equal(unknown.ready, false); checks += 1;
assert.deepEqual(unknown.stages.highClickSpecial.unhandledKeys, ['YJ::high-1']); checks += 1;

// Existing plain blocked rows still count as terminal evidence.
const highClickBlocked = await assessTerminalReportReadiness({
  ...otherStagesAccounted,
  highClickResult: {results: [
    {storeKey: 'YJ', skc: 'high-1', status: 'platform_or_inventory_blocked', ok: false},
  ]},
  root,
});
assert.equal(highClickBlocked.ready, true); checks += 1;
assert.equal(highClickBlocked.stages.highClickSpecial.unhandledCount, 0); checks += 1;

await fs.rm(root, {recursive: true, force: true});
console.log(JSON.stringify({ok: true, checks}, null, 2));
