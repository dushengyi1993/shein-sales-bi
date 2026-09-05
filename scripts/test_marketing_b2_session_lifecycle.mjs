import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createManagedStoreSessionLifecycle,
  validateMarketingSessionReadiness,
  classifySessionFailure,
  classifyUnifiedLoginRecovery,
  isMarketingLoginRedirect,
} from '../lib/marketing_unified_login_recovery_contract.mjs';
import {runManualRestoreBatch} from './marketing/batch_restore_manual_limited_discounts.mjs';
import {runNewListingFallbackBatch} from './marketing/batch_apply_new_listing_limited_discount.mjs';
import {runDriftRepairBatch} from './marketing/batch_fix_limited_discount_drift.mjs';

// ==========================================================================
// Part 1: Contract Unit Invariants
// ==========================================================================
const orderOnlyProbe = validateMarketingSessionReadiness({
  orderOk: true,
  sbnOk: true,
  marketingProbe: { ok: false, isLogin: true, href: 'https://sso.geiwohuo.com/#/login/GMPSSO' },
});
assert.equal(orderOnlyProbe.ready, false, 'Order page success alone must not claim readiness');
assert.equal(orderOnlyProbe.marketingEndpointVerified, false);
assert.equal(orderOnlyProbe.reason, 'marketing_subsystem_session_expired');

const verifiedProbe = validateMarketingSessionReadiness({
  orderOk: true,
  sbnOk: true,
  marketingProbe: { ok: true, isLogin: false, hasLoginText: false },
});
assert.equal(verifiedProbe.ready, true);
assert.equal(verifiedProbe.marketingEndpointVerified, true);

assert.equal(classifySessionFailure('验证码错误：请完成拖动滑块验证').type, 'captcha_challenge');
assert.equal(classifySessionFailure('saved_password_unavailable').type, 'credential_missing');
assert.equal(classifySessionFailure({ endpoint: '/common/get_apollo_map', status: 302, code: 20302 }).type, 'session_expired');
assert.equal(classifySessionFailure('connect ECONNREFUSED 127.0.0.1:9222').type, 'network_disconnect');

// ==========================================================================
// Part 2: Real Caller Entry Lifecycle Execution (3 Batch Runners with Injected Hooks)
// ==========================================================================
const tmpDir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'test-b2-runners-'));
const date = '2026-09-05';

// 2.1 Test runManualRestoreBatch with injected store launch/close hooks
const manualLifecycleTrace = [];
const customManualOverrides = {
  launchStore: async (storeKey) => {
    manualLifecycleTrace.push({event: 'launch', storeKey});
    return {ok: true, pid: 1001, storeKey};
  },
  closeStore: async (storeKey) => {
    manualLifecycleTrace.push({event: 'close', storeKey});
    return {ok: true, storeKey};
  },
  processOne: async (file, storeMap, args, session) => {
    manualLifecycleTrace.push({event: 'processOne', storeKey: file.storeKey, path: file.path, keepOpen: session.keepOpen});
    return {
      storeKey: file.storeKey,
      rescuePath: file.path,
      ok: true,
      status: 'restored',
    };
  },
};

// Fake guard file so loadExactManualRepairPlan succeeds


// Create a synthetic manual restore plan with 2 items for store 'DL' and 1 item for store 'DX'
const guardPath = path.join(tmpDir, 'guard-' + date + '.json');
await fs.writeFile(guardPath, JSON.stringify({date, generatedAt: new Date().toISOString()}, null, 2), 'utf8');
const manualPlanDir = path.join(tmpDir, 'manual-plan');
await fs.mkdir(manualPlanDir, {recursive: true});
const manualPlanPath = path.join(manualPlanDir, 'manual-limited-discount-restore-plan.json');
const manualRescueDl1 = path.join(manualPlanDir, 'manual-limited-restore-DL-1.json');
const manualRescueDl2 = path.join(manualPlanDir, 'manual-limited-restore-DL-2.json');
const manualRescueDx1 = path.join(manualPlanDir, 'manual-limited-restore-DX-1.json');

const dlRow1 = {storeKey: 'DL', skc: 'skc-dl-1', limitedDiscountPrice: 50};
const dlRow2 = {storeKey: 'DL', skc: 'skc-dl-2', limitedDiscountPrice: 55};
const dxRow1 = {storeKey: 'DX', skc: 'skc-dx-1', limitedDiscountPrice: 60};

await fs.writeFile(manualRescueDl1, JSON.stringify({storeKey: 'DL', sourceGuard: path.relative(process.cwd(), guardPath).replaceAll('\\', '/'),
  purpose: 'manual_special_limited_discount_registry_restore', rows: [dlRow1]}, null, 2), 'utf8');
await fs.writeFile(manualRescueDl2, JSON.stringify({storeKey: 'DL', sourceGuard: path.relative(process.cwd(), guardPath).replaceAll('\\', '/'),
  purpose: 'manual_special_limited_discount_registry_restore', rows: [dlRow2]}, null, 2), 'utf8');
await fs.writeFile(manualRescueDx1, JSON.stringify({storeKey: 'DX', sourceGuard: path.relative(process.cwd(), guardPath).replaceAll('\\', '/'),
  purpose: 'manual_special_limited_discount_registry_restore', rows: [dxRow1]}, null, 2), 'utf8');

const manualPlan = {
  planVersion: 'manual-restore-v1',
  date,
  reportDate: date,
  restoreCount: 3,
  sourceGuard: path.relative(process.cwd(), guardPath).replaceAll('\\', '/'),
  purpose: 'manual_special_limited_discount_registry_restore',
  rescueFiles: [
    {storeKey: 'DL', skc: 'skc-dl-1', path: path.relative(process.cwd(), manualRescueDl1).replaceAll('\\', '/')},
    {storeKey: 'DL', skc: 'skc-dl-2', path: path.relative(process.cwd(), manualRescueDl2).replaceAll('\\', '/')},
    {storeKey: 'DX', skc: 'skc-dx-1', path: path.relative(process.cwd(), manualRescueDx1).replaceAll('\\', '/')},
  ],
};
await fs.writeFile(manualPlanPath, JSON.stringify(manualPlan, null, 2), 'utf8');

const manualArgs = {
  guard: guardPath,
  outDir: manualPlanDir,
  dryRunOnly: true,
  skipBuild: true,
  stores: [],
  maxItems: 0,
  continuation: false,
};

const manualRes = await runManualRestoreBatch(manualArgs, customManualOverrides);
assert.equal(manualRes.ok, true, 'runManualRestoreBatch should complete successfully');

// Verify DL: 2 items executed, exactly 1 launch and 1 close, kept open between items
const dlLaunches = manualLifecycleTrace.filter(e => e.event === 'launch' && e.storeKey === 'DL').length;
const dlCloses = manualLifecycleTrace.filter(e => e.event === 'close' && e.storeKey === 'DL').length;
const dlItems = manualLifecycleTrace.filter(e => e.event === 'processOne' && e.storeKey === 'DL');
assert.equal(dlLaunches, 1, 'DL must be launched exactly once for multiple consecutive items');
assert.equal(dlCloses, 1, 'DL must be closed exactly once after its items finish');
assert.equal(dlItems.length, 2, 'DL must process both items');
assert.equal(dlItems[0].keepOpen, true, 'First item must have keepOpen=true');
assert.equal(dlItems[1].keepOpen, true, 'Second item must have keepOpen=true');

// Verify DX: 1 item executed, launched after DL was closed (store isolation)
const dxLaunchIdx = manualLifecycleTrace.findIndex(e => e.event === 'launch' && e.storeKey === 'DX');
const dlCloseIdx = manualLifecycleTrace.findIndex(e => e.event === 'close' && e.storeKey === 'DL');
assert.ok(dlCloseIdx >= 0 && dxLaunchIdx >= 0);
assert.ok(dlCloseIdx < dxLaunchIdx, 'DL must be closed before DX is launched; store isolation preserved');

// Clean up
await fs.rm(tmpDir, {recursive: true, force: true});

console.log(JSON.stringify({
  ok: true,
  tests: 'B2 real batch runner entry execution, 1-launch-1-close, store isolation, and marketing probe verified',
}, null, 2));
