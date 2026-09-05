import assert from 'node:assert/strict';
import {
  formatOpsBusinessResult,
  buildBusinessResultSnapshot,
} from '../lib/ops_business_result_formatter.mjs';

console.log('Running test_ops_business_result_formatter.mjs with all baseline and edge case tests...');

// ==========================================
// Baseline & Existing Tests (Preserved)
// ==========================================

// Case 1: Empty input must NOT produce false-success
{
  const res = formatOpsBusinessResult({});
  assert.equal(res.status, 'unknown');
  assert.match(res.copy, /运行状态未知，当前无有效确认数据/);
  assert.doesNotMatch(res.copy, /已全部完成/);
  assert.equal(res.needsHuman, false);
}

// Case 2: ok=false with succeededCount=1 and no other items: must be failed/partial and require human attention (never false-success)
{
  const res = formatOpsBusinessResult({
    action: '库存补货',
    ok: false,
    succeededCount: 1,
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.needsHuman, true);
  assert.match(res.copy, /已处理 1 条/);
  assert.match(res.copy, /上游执行未完全通过，需要你人工确认后继续处理/);
  assert.doesNotMatch(res.copy, /无需人工处理/);
}

// Case 3: Real executor row with canonical field: must format store and goods name (not just store DL without goods)
{
  const res = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    action: '每日库存巡检',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      { storeKey: 'DL', canonical: 'SK-7025绞肉机', state: 'blocked', error: '平台当前有订单临时占用' },
    ],
  });
  assert.equal(res.status, 'failed');
  assert.equal(res.failedCount, 1);
  assert.match(res.copy, /DL（款号 SK-7025绞肉机）/);
  assert.match(res.copy, /平台当前有订单临时占用/);
}

// Case 4: Real executor targetUsableInventory with after.totalUsableInventory > target (110 vs 100):
// Must output '高于目标 10', never negative diff like '差额 -10'
{
  const res = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 2, updated: 1, blocked: 1 },
    results: [
      { storeKey: 'FY', canonical: 'SK-UPDATED-001', state: 'updated_readback_matched' },
      {
        storeKey: 'XL',
        canonical: 'SK-PENDING-HIGH',
        state: 'submitted_but_readback_pending',
        historicalRunDate: '2026-08-17',
        targetUsableInventory: 100,
        after: { totalUsableInventory: 110 },
        occupancyChange: { ordinary: 2, temporary: 1 },
      },
    ],
  });
  assert.equal(res.status, 'partial');
  assert.equal(res.succeededCount, 1);
  assert.equal(res.pendingCount, 1);
  assert.match(res.copy, /XL（款号 SK-PENDING-HIGH）/);
  assert.match(res.copy, /8月17日提交的待对账请求/);
  assert.match(res.copy, /实际可用 110（高于目标 10）/);
  assert.doesNotMatch(res.copy, /-10/);
  assert.match(res.copy, /占用变动\[普通 2，临时 1\]/);
}

// Case 5: Non-routine skipped states (skipped_historical_target_differs, historical_readback_matched, deferredHistorical):
// Must be partial/warning, NEVER 'completed' ("已全部完成")
{
  const resDiff = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 2, updated: 1, skipped: 1, blocked: 0 },
    results: [
      { storeKey: 'FY', canonical: 'SK-UPDATED-001', state: 'updated_readback_matched' },
      {
        storeKey: 'XL',
        canonical: 'SK-DIFF-001',
        state: 'skipped_historical_target_differs',
        targetUsableInventory: 100,
        before: { totalUsableInventory: 80 },
        warning: '历史目标已结但当前计划目标不同',
      },
    ],
  });
  assert.equal(resDiff.status, 'partial');
  assert.equal(resDiff.needsHuman, true);
  assert.match(resDiff.copy, /已部分完成/);
  assert.doesNotMatch(resDiff.copy, /已全部完成/);
  assert.match(resDiff.copy, /目标不同或受控顺延 1 条/);
  assert.match(resDiff.copy, /历史目标已结但当前计划目标不同/);

  // With deferredHistorical in counts:
  const resDeferredCounts = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 1, skipped: 0, blocked: 0, deferredHistorical: 2 },
    results: [
      { storeKey: 'FY', canonical: 'SK-UPDATED-001', state: 'updated_readback_matched' },
    ],
  });
  assert.equal(resDeferredCounts.status, 'partial');
  assert.equal(resDeferredCounts.needsHuman, true);
  assert.match(resDeferredCounts.copy, /已部分完成/);
  assert.doesNotMatch(resDeferredCounts.copy, /已全部完成/);
  assert.match(resDeferredCounts.copy, /2 条历史未决请求不在当前计划内已受控顺延/);
}

// Case 6: Routine safe skipped whitelist:
// When all rows are updated_readback_matched or routine skipped, status is 'completed'
{
  const resRoutine = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 2, updated: 1, skipped: 1, blocked: 0 },
    results: [
      { storeKey: 'FY', canonical: 'SK-UPDATED-001', state: 'updated_readback_matched' },
      { storeKey: 'XL', canonical: 'SK-ROUTINE-001', state: 'skipped_target_already_matched' },
    ],
  });
  assert.equal(resRoutine.status, 'completed');
  assert.equal(resRoutine.needsHuman, false);
  assert.match(resRoutine.copy, /已全部完成/);
  assert.match(resRoutine.copy, /条件已满足跳过 1 条/);
  assert.match(resRoutine.copy, /无需人工处理/);
}

// Case 7: Marketing runner with storesProcessed: 1, storesOk: 1, storesFailed: 0, ok: false
// Must be partial (not failed, not completed), needsHuman: true, must NOT say '无需人工处理'
{
  const resMkt = formatOpsBusinessResult({
    totals: {
      storesProcessed: 1,
      storesOk: 1,
      storesFailed: 0,
    },
    results: [],
    ok: false,
  });
  assert.equal(resMkt.status, 'partial');
  assert.equal(resMkt.needsHuman, true);
  assert.match(resMkt.copy, /已部分完成/);
  assert.match(resMkt.copy, /成功处理 1 项/);
  assert.match(resMkt.copy, /上游执行未完全通过，需要你人工确认后继续处理/);
  assert.doesNotMatch(resMkt.copy, /无需人工处理/);
}

// Case 8: Generic failedItems with oldRequestDate grouping
{
  const resOldDate = formatOpsBusinessResult({
    action: '日常巡检',
    status: 'partial',
    succeededCount: 2,
    pendingItems: [
      { store: 'DL', canonicalGoodsSn: 'G1', oldRequestDate: '2026-08-17' },
      { store: 'FY', canonicalGoodsSn: 'G2', oldRequestDate: '2026-08-17' },
      { store: 'XL', canonicalGoodsSn: 'G3' },
    ],
  });
  assert.match(resOldDate.copy, /2 条为 8月17日 提交的旧请求/);
  assert.match(resOldDate.copy, /1 条请求处于处理中状态/);
}

// ==========================================
// 4 Specific Counterexample Tests (New)
// ==========================================

// Counterexample 1: dry_run_ready and planned states
// { schemaVersion: daily..., ok: true, execute: false, results: [{ state: 'dry_run_ready' }] }
// Must explicitly indicate preview only, NOT '已全部完成/成功更新0/无需处理'; and planned rows are not terminal.
{
  const resDryRun = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    ok: true,
    execute: false,
    counts: { dryRunReady: 1, updated: 0, blocked: 0 },
    results: [
      { storeKey: 'DL', canonical: 'SK-PREVIEW-001', state: 'dry_run_ready' },
    ],
  });
  assert.equal(resDryRun.status, 'partial');
  assert.match(resDryRun.copy, /计划预览已就绪（未执行实际写入）/);
  assert.match(resDryRun.copy, /仅完成预览，尚未执行。/);
  assert.doesNotMatch(resDryRun.copy, /无需人工处理（待正式执行确认）/);
  assert.doesNotMatch(resDryRun.copy, /已全部完成：成功更新并回读核对 0 条/);

  // Planned state row cannot be claimed as terminal complete
  const resPlanned = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 0 },
    results: [
      { storeKey: 'DL', canonical: 'SK-PLANNED-001', state: 'planned' },
    ],
  });
  assert.notEqual(resPlanned.status, 'completed');
  assert.equal(resPlanned.needsHuman, true);
  assert.match(resPlanned.copy, /计划待执行状态未达终态/);

  // Counterexample 1b: execute: false, ok: false with dry_run_ready
  // Must NOT enter preview ready or no human; must require human attention and fail closed
  const resDryRunFailed = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    execute: false,
    ok: false,
    results: [
      { storeKey: 'DL', canonical: 'SK-DRY-FAIL', state: 'dry_run_ready' },
    ],
  });
  assert.equal(resDryRunFailed.status, 'failed');
  assert.equal(resDryRunFailed.needsHuman, true);
  assert.match(resDryRunFailed.copy, /上游执行未完全通过，需要你人工确认后继续处理/);
  assert.doesNotMatch(resDryRunFailed.copy, /无需人工处理/);
  assert.doesNotMatch(resDryRunFailed.copy, /计划预览已就绪/);

  // Diagnostics check: verify structured item projection with storeKey/canonical/state
  assert.equal(Array.isArray(resDryRunFailed.diagnostics?.items), true);
  assert.equal(resDryRunFailed.diagnostics.items[0]?.storeKey, 'DL');
  assert.equal(resDryRunFailed.diagnostics.items[0]?.canonical, 'SK-DRY-FAIL');
  assert.equal(resDryRunFailed.diagnostics.items[0]?.state, 'dry_run_ready');
}

// Counterexample 2: Historical pending with historicalTargetUsableInventory=10, targetUsableInventory=100, before=5
// Must explicitly state old target 10 still short by 5, and current target 100 separately; CANNOT compare 100 with 5 to report diff 95.
{
  const resHistPending = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      {
        storeKey: 'XL',
        canonical: 'SK-HIST-001',
        state: 'submitted_but_readback_pending',
        historicalPending: true,
        historicalRunDate: '2026-08-17',
        historicalTargetUsableInventory: 10,
        targetUsableInventory: 100,
        before: { totalUsableInventory: 5 },
      },
    ],
  });
  assert.equal(resHistPending.status, 'partial');
  assert.equal(resHistPending.pendingCount, 1);
  assert.match(resHistPending.copy, /旧请求目标 10 还差 5/);
  assert.match(resHistPending.copy, /本次目标 100/);
  assert.doesNotMatch(resHistPending.copy, /差额 95/);
  assert.doesNotMatch(resHistPending.copy, /低于目标 95/);
}

// Counterexample 3: after exists but totalUsableInventory is null / invalid
// Must NOT fallback to before 90 to fake latest inventory; output actual unknown.
// Only when after is undefined (recovery observation) is before permitted.
{
  const resAfterNull = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      {
        storeKey: 'DL',
        canonical: 'SK-AFTER-NULL',
        state: 'submitted_but_readback_pending',
        targetUsableInventory: 100,
        before: { totalUsableInventory: 90 },
        after: { totalUsableInventory: null },
      },
    ],
  });
  assert.match(resAfterNull.copy, /实际可用未知（回读未获取有效数据）/);
  assert.doesNotMatch(resAfterNull.copy, /实际可用 90/);

  // When after is undefined (pure recovery observation), before IS permitted
  const resRecoveryBefore = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      {
        storeKey: 'DL',
        canonical: 'SK-RECOVERY-BEFORE',
        state: 'submitted_but_readback_pending',
        targetUsableInventory: 100,
        before: { totalUsableInventory: 90 },
      },
    ],
  });
  assert.match(resRecoveryBefore.copy, /实际可用 90（低于目标 10/);
}

// Counterexample 4: formatTargetDifferenceText with false, [], ' '
// Must NOT turn false/[]/' ' into 0; missing or invalid values must not produce fake 0.
// Common English inventory error codes must be mapped to F2 Chinese 人话.
{
  const resFalsy = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      {
        storeKey: 'DL',
        canonical: 'SK-FALSY-001',
        state: 'submitted_but_readback_pending',
        targetUsableInventory: false,
        before: { totalUsableInventory: ' ' },
      },
    ],
  });
  assert.doesNotMatch(resFalsy.copy, /目标 0/);
  assert.doesNotMatch(resFalsy.copy, /实际可用 0/);

  // Common English error mapping to human Chinese
  const resMapped = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    counts: { total: 1, updated: 0, blocked: 1 },
    results: [
      {
        storeKey: 'DL',
        canonical: 'SK-FENCE-001',
        state: 'blocked_by_manual_resolution_fence',
        error: 'exact store/SKC/SKU/warehouse VI scope is permanently fenced by manual resolution; no new inventory POST is permitted',
      },
    ],
  });
  assert.match(resMapped.copy, /命中人工解决规则隔离保护，已禁止重复写入/);
  assert.doesNotMatch(resMapped.copy, /permanently fenced by manual resolution/);
}

// Case 11: Retire candidates report ok=false failure vs normal success
{
  const resFailed = formatOpsBusinessResult({
    action: '待下架链接候选报告筛选',
    ok: false,
    counts: { candidateRows: 5, inputRows: 100 },
  });
  assert.equal(resFailed.status, 'failed');
  assert.equal(resFailed.needsHuman, true);
  assert.match(resFailed.copy, /执行失败/);
  assert.equal(resFailed.diagnostics?.counts?.candidateRows, 5);

  const resSuccess = formatOpsBusinessResult({
    action: '待下架链接候选报告筛选',
    ok: true,
    counts: { candidateRows: 3, inputRows: 50, cannotJudgeRows: 1, excludedByFirstShelf15d: 2 },
  });
  assert.equal(resSuccess.status, 'completed');
  assert.equal(resSuccess.needsHuman, true);
  assert.match(resSuccess.copy, /已全部完成/);
  assert.match(resSuccess.copy, /筛选出 3 条建议下架候选商品/);
  assert.match(resSuccess.copy, /仅供人工核验确认，系统未执行下架写入/);
}

// ==========================================
// 4 Minimal Falsy / Stale / Missing Evidence Counterexamples
// ==========================================

// Counterexample E1: {status:'unknown',succeededCount:1,totalCount:1}
// Must preserve unknown status and require human check, NEVER upgrade to completed or claim no human needed.
{
  const res = formatOpsBusinessResult({ status: 'unknown', succeededCount: 1, totalCount: 1 });
  assert.equal(res.status, 'unknown');
  assert.equal(res.needsHuman, true);
  assert.match(res.copy, /运行状态未知，当前无有效确认数据/);
  assert.doesNotMatch(res.copy, /已全部完成/);
  assert.doesNotMatch(res.copy, /无需人工处理/);
}

// Counterexample E2: {status:'stale',succeededCount:1,totalCount:1}
// Must preserve stale status and require human check, NEVER upgrade to completed.
{
  const res = formatOpsBusinessResult({ status: 'stale', succeededCount: 1, totalCount: 1 });
  assert.equal(res.status, 'stale');
  assert.equal(res.needsHuman, true);
  assert.match(res.copy, /状态已过期，数据时效性未通过核验/);
  assert.match(res.copy, /快照已过期失效，需要你重新核实后继续处理/);
  assert.doesNotMatch(res.copy, /已全部完成/);
  assert.doesNotMatch(res.copy, /无需人工处理/);
}

// Counterexample E3: {mode:'daily',rowCount:null,coverage:{}}
// rowCount is strictly null (not 0 via Number(null)); must fail closed and require human attention.
{
  const res = formatOpsBusinessResult({ mode: 'daily', rowCount: null, coverage: {} });
  assert.equal(res.status, 'failed');
  assert.equal(res.needsHuman, true);
  assert.match(res.copy, /执行失败：部分店铺巡检异常/);
  assert.doesNotMatch(res.copy, /已全部完成/);
  assert.doesNotMatch(res.copy, /无需人工处理/);
}

// Counterexample E4: {schemaVersion:'daily-inventory-replenishment-result/v1',ok:true,counts:{updated:1},results:[]}
// Positive counts without results rows indicates evidence missing; must NOT report completed or no human.
{
  const res = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    ok: true,
    counts: { updated: 1 },
    results: [],
  });
  assert.equal(res.status, 'partial');
  assert.equal(res.needsHuman, true);
  assert.match(res.copy, /执行结果明细缺失/);
  assert.doesNotMatch(res.copy, /已全部完成/);
  assert.doesNotMatch(res.copy, /无需人工处理/);

  // Legal verified 0 items must still be permitted to complete cleanly
  const resZero = formatOpsBusinessResult({
    schemaVersion: 'daily-inventory-replenishment-result/v1',
    ok: true,
    counts: { total: 0 },
    results: [],
  });
  assert.equal(resZero.status, 'completed');
  assert.equal(resZero.needsHuman, false);
  assert.match(resZero.copy, /已全部完成：检查结果为 0 项需要补货。无需人工处理。/);
}

// Empty inventory evidence: schema/ok alone cannot prove a verified zero-item run.
// Count names mirror execute_daily_inventory_replenishment_plan.mjs's final counts.
{
  const schemaVersion = 'daily-inventory-replenishment-result/v1';
  const missingEvidenceInputs = [
    {schemaVersion, ok: true},
    {schemaVersion, ok: true, counts: {}, results: []},
    {schemaVersion, ok: true, counts: {total: 0}},
    ...[null, {}, ''].map(results => ({schemaVersion, ok: true, counts: {total: 0}, results})),
    ...[undefined, null, false, [], ' ', 'invalid', -1].map(total => ({
      schemaVersion, ok: true, counts: {total}, results: [],
    })),
    {schemaVersion, ok: true, counts: {total: 0, updated: null}, results: []},
    {schemaVersion, ok: true, counts: {total: 0, blocked: -1}, results: []},
    {schemaVersion, ok: true, counts: {total: 0}, results: [], deferredHistorical: [{}]},
  ];
  for (const input of missingEvidenceInputs) {
    const res = formatOpsBusinessResult(input);
    assert.equal(res.status, 'unknown', JSON.stringify(input));
    assert.equal(res.needsHuman, true);
    assert.equal(res.succeededCount, null, 'Missing execution evidence is not zero succeeded');
    assert.match(res.copy, /无法确认.*需核对/);
    assert.doesNotMatch(res.copy, /已全部完成|无需人工处理|成功更新.*0|检查结果为 0/);
  }

  const zeroCounts = {total: 0, updated: 0, dryRunReady: 0, skipped: 0, deferredHistorical: 0, blocked: 0};
  for (const ok of [true, undefined, false]) {
    const res = formatOpsBusinessResult({schemaVersion, ok, counts: zeroCounts, results: []});
    assert.equal(res.status, ok === false ? 'failed' : 'completed');
    assert.equal(res.needsHuman, ok === false);
    if (ok === false) {
      assert.match(res.copy, /执行失败.*需核对/);
      assert.doesNotMatch(res.copy, /已全部完成|无需人工处理|检查结果为 0/);
    } else {
      assert.equal(res.succeededCount, 0);
      assert.equal(res.totalCount, 0);
      assert.match(res.copy, /检查结果为 0 项需要补货/);
    }
  }
  // A zero total must not overrule a non-zero count, even when no rows were returned.
  for (const key of ['updated', 'dryRunReady', 'skipped', 'deferredHistorical', 'blocked']) {
    const res = formatOpsBusinessResult({schemaVersion, ok: true, counts: {...zeroCounts, [key]: 1}, results: []});
    assert.equal(res.status, 'partial');
    assert.equal(res.needsHuman, true);
    assert.match(res.copy, /执行结果明细缺失/);
    assert.doesNotMatch(res.copy, /已全部完成|无需人工处理/);
  }
}

// Scan coverage fields come from buildScanDocument / compactCoverage, not invented flags.
// Zero rows from an incomplete scan do not mean there are no pending-discuss goods.
{
  const coverages = [
    {failedStores: ['DL'], expectedCount: 19, succeededCount: 18},
    {failedStores: ['DL'], expectedCount: 19, succeededCount: 19},
    {failedStores: [], missingStores: ['DL'], expectedCount: 19, succeededCount: 18},
    {failedStores: [], missingStores: [], unexpectedStores: ['DL'], expectedCount: 18, succeededCount: 18},
    {failedStores: [], missingStores: [], expectedCount: 19, succeededCount: 18},
    {failedStores: [], expectedCount: 19, succeededCount: null},
    {failedStores: [], expectedCount: 0, succeededCount: 0},
  ];
  for (const coverage of coverages) {
    const res = formatOpsBusinessResult({mode: 'daily', ok: true, rowCount: 0, coverage});
    assert.equal(res.status, 'failed', JSON.stringify(coverage));
    assert.equal(res.needsHuman, true);
    assert.deepEqual(res.diagnostics.coverage, coverage);
    assert.doesNotMatch(res.copy, /已全部完成|无需人工处理|检查结果为 0/);
    if (coverage.failedStores.length) assert.match(res.copy, /DL/);
  }
  const res = formatOpsBusinessResult({
    mode: 'daily', ok: true, rowCount: 0,
    coverage: {expectedCount: 19, succeededCount: 19, failedStores: [], missingStores: [], unexpectedStores: []},
  });
  assert.equal(res.status, 'completed');
  assert.equal(res.needsHuman, false);
  assert.match(res.copy, /检查结果为 0 项待议价商品/);
}

console.log('✓ All baseline and updated counterexample tests passed successfully');
