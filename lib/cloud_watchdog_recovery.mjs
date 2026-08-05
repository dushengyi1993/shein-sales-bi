import path from 'node:path';

export const DAILY_MARKETING_SCAN_WARNING = 'marketing price scan failed';
export const DAILY_OPENAPI_PRODUCT_WARNING = 'openapi product reconciliation failed';
export const DAILY_OPENAPI_SALES_WARNING = 'openapi reconciliation failed';
export const DAILY_LINK_BUSINESS_WARNINGS = new Set([
  'link-business failed',
  'link-business partial',
  'link-business metrics not ready',
  'link-business failed link-business partial',
  'link-business failed link-business metrics not ready',
  'link-business partial link-business metrics not ready',
  'link-business failed link-business partial link-business metrics not ready',
]);

function normalizedStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function instant(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function failed(reason, details = {}) {
  return {recovered: false, reason, ...details};
}

function shanghaiClock(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

/**
 * systemd records a skipped ExecCondition as Result=exec-condition while the
 * unit remains inactive and ExecMainStatus is zero. That is an expected
 * schedule decision, not a crashed oneshot.
 */
export function assessSystemdOneshotResult(status = {}) {
  const exitStatus = String(status?.ExecMainStatus || '');
  const expectedConditionSkip = status?.Result === 'exec-condition'
    && (!exitStatus || exitStatus === '0');
  const resultOk = !status?.Result || status.Result === 'success' || expectedConditionSkip;
  const abnormalExit = status?.ActiveState !== 'active'
    && !resultOk
    && Boolean(exitStatus)
    && exitStatus !== '0';
  const abnormalState = status?.ActiveState === 'failed' || !resultOk;
  return {
    exitStatus,
    expectedConditionSkip,
    resultOk,
    abnormalExit,
    abnormalState,
  };
}

/**
 * The marketing guard has three daily retry windows. Do not page on the first
 * failed attempt; after the final retry grace period, require one immutable
 * successful complete inspection for the current Shanghai business date.
 * Large write backlogs are assessed separately by
 * assessDailyMarketingRepairHealth so they cannot keep the inspection process
 * alive for hours or masquerade as a completed repair.
 */
export function assessDailyMarketingGuardHealth({
  guardState,
  lastOkState,
  guardRunning = false,
  guardStartedAt = '',
  maxRunMinutes = 35,
  nowMs = Date.now(),
  finalDeadlineMinute = 17 * 60 + 45,
} = {}) {
  const clock = shanghaiClock(nowMs);
  const base = {
    today: clock.date,
    finalDeadlineMinute,
    lastStatus: guardState?.status || null,
    lastDate: guardState?.date || null,
    lastGeneratedAt: guardState?.generatedAt || null,
    lastOkDate: lastOkState?.date || null,
    lastOkGeneratedAt: lastOkState?.generatedAt || null,
    activeStartedAt: guardStartedAt || null,
  };
  if (guardRunning) {
    const startedAt = instant(guardStartedAt);
    const activeAgeMinutes = Number.isFinite(startedAt) ? (nowMs - startedAt) / 60_000 : null;
    if (activeAgeMinutes === null) {
      return {healthy: false, pending: false, reason: 'active_start_unknown', activeAgeMinutes, maxRunMinutes, ...base};
    }
    if (activeAgeMinutes > maxRunMinutes) {
      return {healthy: false, pending: false, reason: 'final_run_overdue', activeAgeMinutes, maxRunMinutes, ...base};
    }
    return {healthy: true, pending: true, reason: 'final_run_active', activeAgeMinutes, maxRunMinutes, ...base};
  }
  if (clock.minuteOfDay < finalDeadlineMinute) {
    return {healthy: true, pending: true, reason: 'retry_window_open', ...base};
  }

  if (!lastOkState || lastOkState.error) {
    return {healthy: false, pending: false, reason: lastOkState?.error ? 'last_ok_state_unreadable' : 'last_ok_state_missing', ...base};
  }
  const okAt = instant(lastOkState.generatedAt);
  if (lastOkState.status !== 'ok' || lastOkState.date !== clock.date || !Number.isFinite(okAt)) {
    return {healthy: false, pending: false, reason: 'today_success_missing', ...base};
  }
  if (okAt > nowMs + 5 * 60_000) {
    return {healthy: false, pending: false, reason: 'today_success_from_future', ...base};
  }

  const lastAt = instant(guardState?.generatedAt);
  const newerSameDayFailure = guardState
    && !guardState.error
    && guardState.date === clock.date
    && guardState.status !== 'ok'
    && Number.isFinite(lastAt)
    && lastAt > okAt;
  if (newerSameDayFailure) {
    return {healthy: false, pending: false, reason: 'newer_failure_after_success', ...base};
  }

  return {healthy: true, pending: false, reason: 'today_success_verified', ...base};
}

/**
 * Large marketing corrections are intentionally separated from the fast live
 * inspection. They may resume in bounded chunks during the day, but by the
 * final worker deadline the current business date must have an empty/completed
 * exact queue and a final live readback.
 */
export function assessDailyMarketingRepairHealth({
  queueState,
  repairState,
  repairRunning = false,
  repairStartedAt = '',
  maxRunMinutes = 45,
  nowMs = Date.now(),
  finalDeadlineMinute = 20 * 60,
} = {}) {
  const clock = shanghaiClock(nowMs);
  const base = {
    today: clock.date,
    finalDeadlineMinute,
    queueDate: queueState?.date || null,
    queueStatus: queueState?.status || null,
    queueCounts: queueState?.counts || null,
    repairStatus: repairState?.status || null,
    repairGeneratedAt: repairState?.generatedAt || null,
    activeStartedAt: repairStartedAt || null,
  };
  if (queueState?.error) return {healthy: false, pending: false, reason: 'repair_queue_unreadable', ...base};
  if (repairRunning) {
    const startedAt = instant(repairStartedAt);
    const activeAgeMinutes = Number.isFinite(startedAt) ? (nowMs - startedAt) / 60_000 : null;
    if (activeAgeMinutes === null) {
      return {healthy: false, pending: false, reason: 'repair_active_start_unknown', activeAgeMinutes, maxRunMinutes, ...base};
    }
    if (activeAgeMinutes > maxRunMinutes) {
      return {healthy: false, pending: false, reason: 'repair_worker_overdue', activeAgeMinutes, maxRunMinutes, ...base};
    }
    return {healthy: true, pending: true, reason: 'repair_worker_active', activeAgeMinutes, maxRunMinutes, ...base};
  }
  if (queueState?.date === clock.date && queueState?.status === 'completed') {
    return {healthy: true, pending: false, reason: 'today_repair_queue_completed', ...base};
  }
  if (queueState?.date === clock.date && queueState?.status === 'blocked') {
    return {healthy: true, pending: false, reason: 'today_repair_queue_blocked_and_reported', ...base};
  }
  if (clock.minuteOfDay < finalDeadlineMinute) {
    return {healthy: true, pending: true, reason: 'repair_windows_open', ...base};
  }
  if (!queueState) return {healthy: false, pending: false, reason: 'today_repair_queue_missing', ...base};
  if (queueState.date !== clock.date) return {healthy: false, pending: false, reason: 'today_repair_queue_missing', ...base};
  if (queueState.status === 'failed') return {healthy: false, pending: false, reason: 'repair_queue_failed', ...base};
  if (queueState.status === 'awaiting_final_readback') {
    return {healthy: false, pending: false, reason: 'repair_final_readback_missing', ...base};
  }
  return {healthy: false, pending: false, reason: 'repair_queue_not_completed', ...base};
}

export function assessDailyLinkBusinessRecovery({
  dailyRefresh,
  linkSuccess,
  expectedStoreKeys,
  nowMs = Date.now(),
} = {}) {
  if (dailyRefresh?.status !== 'warning') return failed('daily_status_not_warning');
  if (!DAILY_LINK_BUSINESS_WARNINGS.has(String(dailyRefresh?.message || '').trim())) {
    return failed('daily_warning_not_link_business_only');
  }
  if (!linkSuccess) return failed('link_business_success_evidence_missing');

  const dailyAt = instant(dailyRefresh.generatedAt);
  const successAt = instant(linkSuccess.generatedAt);
  if (![dailyAt, successAt].every(Number.isFinite)) return failed('link_business_recovery_timestamp_invalid');
  if (successAt <= dailyAt) return failed('link_business_recovery_not_newer_than_daily_warning');
  if (successAt > nowMs + 5 * 60_000) return failed('link_business_recovery_from_future');
  if (String(linkSuccess.date || '') !== String(dailyRefresh.date || '')) {
    return failed('link_business_recovery_date_mismatch');
  }
  if (
    linkSuccess.ok !== true
    || linkSuccess.metricReady !== true
    || linkSuccess.warehouseLoaded !== true
    || linkSuccess.portalRefreshed !== true
  ) {
    return failed('link_business_recovery_not_complete');
  }

  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!expected.length) return failed('expected_store_set_missing');
  if (!Array.isArray(linkSuccess.successfulStores)) return failed('link_business_success_stores_missing');
  const actualRows = linkSuccess.successfulStores.map(normalizedStoreKey).filter(Boolean);
  const actual = [...new Set(actualRows)].sort();
  if (actual.length !== actualRows.length) return failed('link_business_success_stores_duplicated');
  const failedStores = Array.isArray(linkSuccess.failedStores)
    ? linkSuccess.failedStores.map(normalizedStoreKey).filter(Boolean)
    : [];
  const missingStores = expected.filter(storeKey => !actual.includes(storeKey));
  const unexpectedStores = actual.filter(storeKey => !expected.includes(storeKey));
  if (failedStores.length || missingStores.length || unexpectedStores.length) {
    return failed('link_business_recovery_store_coverage_incomplete', {
      failedStores,
      missingStores,
      unexpectedStores,
    });
  }

  return {
    recovered: true,
    reason: 'newer_complete_all_store_link_business_sync',
    evidence: {
      type: 'daily_link_business_recovery',
      dailyDate: dailyRefresh.date || null,
      dailyGeneratedAt: dailyRefresh.generatedAt,
      successGeneratedAt: linkSuccess.generatedAt,
      successfulStores: expected.length,
      metricReady: true,
      warehouseLoaded: true,
      portalRefreshed: true,
      logFile: linkSuccess.logFile || null,
    },
  };
}

export function assessDailyOpenapiSalesRecovery({
  dailyRefresh,
  salesReport,
  expectedStoreKeys,
  nowMs = Date.now(),
} = {}) {
  if (dailyRefresh?.status !== 'warning') return failed('daily_status_not_warning');
  if (String(dailyRefresh?.message || '').trim() !== DAILY_OPENAPI_SALES_WARNING) {
    return failed('daily_warning_not_openapi_sales_only');
  }
  if (!salesReport) return failed('openapi_sales_recovery_evidence_missing');

  const dailyAt = instant(dailyRefresh.generatedAt);
  const reportAt = instant(salesReport.generatedAt);
  if (![dailyAt, reportAt].every(Number.isFinite)) return failed('openapi_sales_recovery_timestamp_invalid');
  if (reportAt <= dailyAt) return failed('openapi_sales_recovery_not_newer_than_daily_warning');
  if (reportAt > nowMs + 5 * 60_000) return failed('openapi_sales_recovery_from_future');
  if (String(salesReport.date || '') !== String(dailyRefresh.date || '')) {
    return failed('openapi_sales_recovery_date_mismatch');
  }

  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!expected.length) return failed('expected_store_set_missing');
  const requestedRows = Array.isArray(salesReport.requestedStores)
    ? salesReport.requestedStores.map(normalizedStoreKey).filter(Boolean)
    : [];
  const requested = [...new Set(requestedRows)].sort();
  const results = Array.isArray(salesReport.results) ? salesReport.results : [];
  const resultRows = results.map(row => normalizedStoreKey(row?.storeKey)).filter(Boolean);
  const actual = [...new Set(resultRows)].sort();
  const missingStores = expected.filter(storeKey => !actual.includes(storeKey));
  const unexpectedStores = actual.filter(storeKey => !expected.includes(storeKey));
  const requestedMismatch = requested.length !== expected.length
    || expected.some(storeKey => !requested.includes(storeKey))
    || requestedRows.length !== requested.length;
  const counts = salesReport.counts || {};
  const complete = salesReport.ok === true
    && Number(counts.total) === expected.length
    && Number(counts.succeeded) === expected.length
    && Number(counts.matched) === expected.length
    && Number(counts.failed || 0) === 0
    && Number(counts.warning || 0) === 0
    && Number(counts.missingBrowser || 0) === 0
    && Number(counts.skipped || 0) === 0
    && results.length === expected.length
    && resultRows.length === actual.length
    && results.every(row => row?.ok === true && row?.status === 'matched');
  if (!complete || requestedMismatch || missingStores.length || unexpectedStores.length) {
    return failed('openapi_sales_recovery_store_coverage_incomplete', {
      counts,
      requestedMismatch,
      missingStores,
      unexpectedStores,
    });
  }

  return {
    recovered: true,
    reason: 'newer_complete_all_store_openapi_sales_reconciliation',
    evidence: {
      type: 'daily_openapi_sales_recovery',
      dailyDate: dailyRefresh.date || null,
      dailyGeneratedAt: dailyRefresh.generatedAt,
      reportGeneratedAt: salesReport.generatedAt,
      successfulStores: expected.length,
      matchedStores: Number(counts.matched),
    },
  };
}

export function resolveMarketingScanEvidencePath(root, scanFile) {
  if (!root || !scanFile || !path.isAbsolute(scanFile)) return null;
  const allowedDir = path.resolve(root, 'tmp', 'marketing-signup', 'current-price-live');
  const candidate = path.resolve(scanFile);
  if (!candidate.toLowerCase().endsWith('.json')) return null;
  if (candidate !== allowedDir && !candidate.startsWith(`${allowedDir}${path.sep}`)) return null;
  return candidate;
}

export function assessDailyMarketingScanRecovery({
  dailyRefresh,
  guardState,
  scanSnapshot,
  expectedStoreKeys,
  nowMs = Date.now(),
  maxScanAgeHours = 24,
} = {}) {
  if (dailyRefresh?.status !== 'warning') return failed('daily_status_not_warning');
  if (String(dailyRefresh?.message || '').trim() !== DAILY_MARKETING_SCAN_WARNING) {
    return failed('daily_warning_not_scan_only');
  }
  if (!guardState || !scanSnapshot) return failed('recovery_evidence_missing');

  const dailyAt = instant(dailyRefresh.generatedAt);
  const guardAt = instant(guardState.generatedAt);
  const scanAt = instant(scanSnapshot.updatedAt || scanSnapshot.createdAt);
  if (![dailyAt, guardAt, scanAt].every(Number.isFinite)) return failed('recovery_timestamp_invalid');
  if (guardAt <= dailyAt || scanAt <= dailyAt) return failed('recovery_not_newer_than_daily_warning');
  if (guardAt > nowMs + 5 * 60_000) return failed('recovery_guard_from_future');
  if (scanAt > nowMs + 5 * 60_000) return failed('recovery_scan_from_future');
  if ((nowMs - scanAt) / 36e5 > maxScanAgeHours) return failed('recovery_scan_stale');
  if (guardAt + 5 * 60_000 < scanAt) return failed('guard_state_older_than_scan');

  if (scanSnapshot.ok !== true || scanSnapshot.partial !== false) return failed('recovery_scan_not_complete');
  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!expected.length) return failed('expected_store_set_missing');
  if (!Array.isArray(scanSnapshot.stores)) return failed('recovery_store_rows_missing');

  const rowsByStore = new Map();
  const duplicateStores = [];
  const invalidStoreRows = [];
  for (const row of scanSnapshot.stores) {
    const storeKey = normalizedStoreKey(row?.store || row?.storeKey);
    if (!storeKey) {
      invalidStoreRows.push(row);
      continue;
    }
    if (rowsByStore.has(storeKey)) duplicateStores.push(storeKey);
    else rowsByStore.set(storeKey, row);
  }
  if (invalidStoreRows.length) return failed('recovery_store_key_missing', {invalidStoreRowCount: invalidStoreRows.length});
  if (duplicateStores.length) return failed('recovery_store_rows_duplicated', {duplicateStores: [...new Set(duplicateStores)].sort()});

  const actual = [...rowsByStore.keys()].sort();
  const missingStores = expected.filter(storeKey => !rowsByStore.has(storeKey));
  const unexpectedStores = actual.filter(storeKey => !expected.includes(storeKey));
  const failedStores = expected.filter(storeKey => rowsByStore.get(storeKey)?.ok !== true);
  if (missingStores.length || unexpectedStores.length || failedStores.length) {
    return failed('recovery_store_coverage_incomplete', {missingStores, unexpectedStores, failedStores});
  }

  const rowCount = Number(scanSnapshot.rowCount);
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || !Array.isArray(scanSnapshot.rows) || scanSnapshot.rows.length !== rowCount) {
    return failed('recovery_row_count_invalid');
  }
  const storePayloadsComplete = expected.every(storeKey => Array.isArray(rowsByStore.get(storeKey)?.rows));
  const perStoreRowCount = storePayloadsComplete
    ? expected.reduce((total, storeKey) => total + rowsByStore.get(storeKey).rows.length, 0)
    : -1;
  if (!storePayloadsComplete || perStoreRowCount !== rowCount) return failed('recovery_store_payload_incomplete');

  return {
    recovered: true,
    reason: 'newer_complete_all_store_scan',
    evidence: {
      type: 'daily_marketing_price_scan_recovery',
      dailyDate: dailyRefresh.date || null,
      dailyGeneratedAt: dailyRefresh.generatedAt,
      guardStatus: guardState.status || null,
      guardGeneratedAt: guardState.generatedAt,
      scanFile: guardState.scanFile || null,
      scanUpdatedAt: scanSnapshot.updatedAt || scanSnapshot.createdAt,
      successfulStores: expected.length,
      rowCount,
    },
  };
}

export function assessDailyOpenapiProductRecovery({
  dailyRefresh,
  productReport,
  expectedStoreKeys,
  nowMs = Date.now(),
  maxReportAgeHours = 48,
} = {}) {
  if (dailyRefresh?.status !== 'warning') return failed('daily_status_not_warning');
  if (String(dailyRefresh?.message || '').trim() !== DAILY_OPENAPI_PRODUCT_WARNING) {
    return failed('daily_warning_not_openapi_product_only');
  }
  if (!productReport) return failed('openapi_product_recovery_evidence_missing');

  const dailyAt = instant(dailyRefresh.generatedAt);
  const reportAt = instant(productReport.generatedAt || productReport.endedAt);
  if (![dailyAt, reportAt].every(Number.isFinite)) return failed('openapi_product_recovery_timestamp_invalid');
  if (reportAt <= dailyAt) return failed('openapi_product_recovery_not_newer_than_daily_warning');
  if (reportAt > nowMs + 5 * 60_000) return failed('openapi_product_recovery_from_future');
  if ((nowMs - reportAt) / 36e5 > maxReportAgeHours) return failed('openapi_product_recovery_stale');
  if (productReport.ok !== true || productReport.ensure?.ok !== true || Number(productReport.counts?.failed || 0) !== 0) {
    return failed('openapi_product_recovery_not_complete');
  }

  const expected = [...new Set((expectedStoreKeys || []).map(normalizedStoreKey).filter(Boolean))].sort();
  if (!expected.length) return failed('expected_store_set_missing');
  const rows = Array.isArray(productReport.results) ? productReport.results : [];
  const actualRows = rows.map(row => normalizedStoreKey(row?.storeKey)).filter(Boolean);
  const actual = [...new Set(actualRows)].sort();
  if (actual.length !== actualRows.length) return failed('openapi_product_recovery_store_rows_duplicated');
  const failedStores = rows.filter(row => row?.ok !== true).map(row => normalizedStoreKey(row?.storeKey)).filter(Boolean);
  const missingStores = expected.filter(storeKey => !actual.includes(storeKey));
  const unexpectedStores = actual.filter(storeKey => !expected.includes(storeKey));
  if (failedStores.length || missingStores.length || unexpectedStores.length) {
    return failed('openapi_product_recovery_store_coverage_incomplete', {failedStores, missingStores, unexpectedStores});
  }

  return {
    recovered: true,
    reason: 'newer_complete_all_store_openapi_product_reconciliation',
    evidence: {
      type: 'daily_openapi_product_recovery',
      dailyDate: dailyRefresh.date || null,
      dailyGeneratedAt: dailyRefresh.generatedAt,
      reportGeneratedAt: productReport.generatedAt || productReport.endedAt,
      successfulStores: expected.length,
      matched: Number(productReport.counts?.matched || 0),
      warning: Number(productReport.counts?.warning || 0),
    },
  };
}
