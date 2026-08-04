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

await fs.rm(root, {recursive: true, force: true});
console.log(JSON.stringify({ok: true, checks}, null, 2));
