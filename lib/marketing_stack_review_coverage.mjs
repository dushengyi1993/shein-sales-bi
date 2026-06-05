function normStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function isCouponActivitySummary(activity) {
  const type = String(activity?.type || '').toLowerCase();
  const name = String(activity?.name || activity?.activityName || '');
  return type === 'coupon' || /优惠券|coupon/i.test(name);
}

function diagnosticIssue(diagnostics = []) {
  return diagnostics
    .filter(x => {
      const code = String(x?.code ?? '').trim();
      return code && !(code === '0' || code.toUpperCase() === 'OK');
    })
    .map(x => [x?.code, x?.msg].filter(Boolean).join(' '))
    .filter(Boolean)
    .join('；');
}

function diagnosticHasFailure(diagnostics = []) {
  return diagnostics.some(x => {
    const code = String(x?.code ?? '').trim();
    if (!code) return false;
    return !(code === '0' || code.toUpperCase() === 'OK');
  });
}

export function summarizeStoreAuditCoverage(doc, fallbackStoreKey = '') {
  if (!doc) {
    return {
      storeKey: normStoreKey(fallbackStoreKey),
      ok: false,
      rowCount: 0,
      couponCount: 0,
      ordinaryActivityCount: 0,
      activityListCount: 0,
      issue: 'missing_store_audit',
    };
  }
  const activities = Array.isArray(doc.activities) ? doc.activities : [];
  const diagnostics = Array.isArray(doc.activityFetchDiagnostics) ? doc.activityFetchDiagnostics : [];
  const ordinaryActivities = activities.filter(a => !isCouponActivitySummary(a));
  const rowCount = Number(doc.rowCount ?? (Array.isArray(doc.rows) ? doc.rows.length : 0)) || 0;
  const couponCount = Number(doc.couponCount ?? (Array.isArray(doc.couponSummaries) ? doc.couponSummaries.length : 0)) || 0;
  const activityListCount = Number(doc.activityListCount ?? activities.length) || 0;
  const issueFromDiagnostics = diagnosticIssue(diagnostics);
  const storeKey = normStoreKey(doc.storeKey || doc.store || fallbackStoreKey);

  if (doc.ok === false) {
    return {
      storeKey,
      ok: false,
      rowCount,
      couponCount,
      ordinaryActivityCount: ordinaryActivities.length,
      activityListCount,
      issue: doc.error || issueFromDiagnostics || 'store_audit_failed',
    };
  }

  if (diagnosticHasFailure(diagnostics)) {
    return {
      storeKey,
      ok: false,
      rowCount,
      couponCount,
      ordinaryActivityCount: ordinaryActivities.length,
      activityListCount,
      issue: issueFromDiagnostics || 'activity_list_diagnostic_failed',
    };
  }

  if (ordinaryActivities.length === 0) {
    return {
      storeKey,
      ok: true,
      rowCount,
      couponCount,
      ordinaryActivityCount: 0,
      activityListCount,
      issue: 'no_open_ordinary_activities',
    };
  }

  if (rowCount > 0) {
    return {
      storeKey,
      ok: true,
      rowCount,
      couponCount,
      ordinaryActivityCount: ordinaryActivities.length,
      activityListCount,
      issue: '',
    };
  }

  const collected = ordinaryActivities.map(a => a?.collected || null).filter(Boolean);
  const hasExplicitNoGoodsEvidence = c => (
    c?.ok === true
    && Object.prototype.hasOwnProperty.call(c, 'totalGoods')
    && Number(c.totalGoods) === 0
    && !String(c.reason || c.error || '').trim()
  );
  const allCollectedNoGoods = collected.length === ordinaryActivities.length
    && collected.every(hasExplicitNoGoodsEvidence);
  if (allCollectedNoGoods) {
    return {
      storeKey,
      ok: true,
      rowCount,
      couponCount,
      ordinaryActivityCount: ordinaryActivities.length,
      activityListCount,
      issue: 'open_ordinary_activities_no_goods',
    };
  }

  return {
    storeKey,
    ok: false,
    rowCount,
    couponCount,
    ordinaryActivityCount: ordinaryActivities.length,
    activityListCount,
    issue: issueFromDiagnostics || 'ordinary_activity_rows_missing',
  };
}

export function summarizeStackReviewCoverage(stackDoc, storesConfigDoc = null) {
  const selectedStores = Array.isArray(stackDoc?.selectedStores) ? stackDoc.selectedStores : [];
  const storeStatuses = Array.isArray(stackDoc?.storeStatuses) ? stackDoc.storeStatuses : [];
  const explicitMissingStores = Array.isArray(stackDoc?.missingStores) ? stackDoc.missingStores.map(normStoreKey).filter(Boolean) : [];
  const enabledStoreKeys = Array.isArray(storesConfigDoc?.stores)
    ? storesConfigDoc.stores.filter(s => s.enabled !== false).map(s => normStoreKey(s.storeKey)).filter(Boolean)
    : [];
  const selectedStoreKeys = selectedStores.map(s => normStoreKey(s.storeKey || s.store || s)).filter(Boolean);
  const statusStoreKeys = storeStatuses.map(s => normStoreKey(s.storeKey || s.store || s)).filter(Boolean);
  const failedStatuses = storeStatuses.filter(s => s?.ok !== true);
  const missingFromStatuses = storeStatuses
    .filter(s => s?.ok !== true)
    .map(s => normStoreKey(s.storeKey || s.store))
    .filter(Boolean);
  const missingFromEnabled = enabledStoreKeys.filter(k => !selectedStoreKeys.includes(k));
  const statusMissingForSelected = selectedStoreKeys.filter(k => !statusStoreKeys.includes(k));
  const missingStores = [...new Set([
    ...explicitMissingStores,
    ...missingFromStatuses,
    ...missingFromEnabled,
    ...statusMissingForSelected,
  ])];
  const selectedStoreCount = selectedStoreKeys.length;
  const enabledStoreCount = enabledStoreKeys.length || null;
  const storeStatusCount = statusStoreKeys.length;
  const completedStoreCount = storeStatuses.filter(s => s?.ok === true).length;
  const hasExplicitStoreCoverage = Boolean(storeStatuses.length && selectedStores.length);
  const coverageComplete = Boolean(
    hasExplicitStoreCoverage
    && (!enabledStoreCount || selectedStoreCount === enabledStoreCount)
    && storeStatusCount === selectedStoreCount
    && completedStoreCount === selectedStoreCount
    && missingStores.length === 0
  );
  const issues = [];
  if (!hasExplicitStoreCoverage) issues.push('missing_explicit_store_coverage');
  if (enabledStoreCount && selectedStoreCount !== enabledStoreCount) issues.push('selected_store_count_mismatch');
  if (storeStatusCount !== selectedStoreCount) issues.push('store_status_count_mismatch');
  if (completedStoreCount !== selectedStoreCount) issues.push('completed_store_count_mismatch');
  if (missingStores.length) issues.push('missing_or_failed_stores');
  return {
    selectedStoreCount,
    enabledStoreCount,
    storeStatusCount,
    completedStoreCount,
    missingStoreCount: missingStores.length,
    missingStores: missingStores.slice(0, 30),
    failedStatuses: failedStatuses.slice(0, 30),
    hasExplicitStoreCoverage,
    coverageComplete,
    issues,
  };
}
