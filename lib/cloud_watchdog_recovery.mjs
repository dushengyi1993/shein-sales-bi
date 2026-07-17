import path from 'node:path';

export const DAILY_MARKETING_SCAN_WARNING = 'marketing price scan failed';
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
