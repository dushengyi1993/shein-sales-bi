function issueCount(value) {
  if (value === undefined || value === null || value === '') return Number.NaN;
  if (Array.isArray(value)) return value.length;
  const count = Number(value);
  return Number.isFinite(count) ? count : Number.NaN;
}

function isZero(value) {
  return issueCount(value) === 0;
}

function storeCoverageIsComplete(store) {
  if (!store || typeof store !== 'object') return false;
  if (store.identityOk !== true || store.loginRecoveryOk !== true) return false;
  if (store.approvedRowsOk !== true) return false;
  const planned = Number(store.plannedRows);
  const checked = store.checkedRows === undefined ? planned : Number(store.checkedRows);
  return Number.isInteger(planned)
    && planned >= 0
    && Number.isInteger(checked)
    && checked === planned
    && isZero(store.missingRows)
    && isZero(store.priceMismatchRows)
    && isZero(store.badPacketActivities);
}

export function scopeOrdinaryEnrollmentReadbackToApprovedRows(summary) {
  if (!summary || typeof summary !== 'object') return {ok: false, reason: 'verify output missing'};

  const observedExtraAvailableRows = issueCount(summary.extraAvailableRows);
  const observedActivityListGapRows = issueCount(summary.activityListGapRows);
  const plannedRows = Number(summary.plannedRows);
  const checkedRows = Number(summary.checkedRows);
  const requestedStores = Array.isArray(summary.stores) ? summary.stores : [];
  const byStore = summary.byStore && typeof summary.byStore === 'object' ? summary.byStore : {};
  const storeKeys = new Set(requestedStores);
  const storeEntries = requestedStores.map(storeKey => byStore[storeKey]);
  const perStorePlannedRows = storeEntries.reduce((sum, store) => sum + Number(store?.plannedRows ?? Number.NaN), 0);
  const perStoreCheckedRows = storeEntries.reduce((sum, store) => sum + Number(store?.checkedRows ?? store?.plannedRows ?? Number.NaN), 0);
  const coverageOk = Number.isInteger(plannedRows)
    && plannedRows > 0
    && Number.isInteger(checkedRows)
    && checkedRows === plannedRows
    && requestedStores.length > 0
    && storeKeys.size === requestedStores.length
    && requestedStores.every(storeKey => Object.hasOwn(byStore, storeKey))
    && storeEntries.every(store => storeCoverageIsComplete(store))
    && perStorePlannedRows === plannedRows
    && perStoreCheckedRows === checkedRows;
  const currentRowsOk = isZero(summary.missingRows)
    && isZero(summary.priceMismatchRows)
    && isZero(summary.badPacketActivities);
  const ok = coverageOk && currentRowsOk;
  return {
    ...summary,
    ok,
    scope: 'current_approved_submission_rows',
    coverageOk,
    currentRowsOk,
    observedExtraAvailableRows,
    observedActivityListGapRows,
    // Later rows visible on the activity page are outside this locked
    // submission scope. Keep their evidence above, but do not fail this
    // readback unless an approved row is missing or has a bad price.
    extraAvailableRows: 0,
    activityListGapRows: 0,
    reason: ok ? '' : (summary.reason || (coverageOk
      ? 'approved submission rows missing, mismatched, or unreadable'
      : `approved submission readback coverage incomplete: checked=${checkedRows} planned=${plannedRows}`)),
  };
}

export function wrapOrdinaryEnrollmentReadbackForTransaction(scoped) {
  const summary = scoped && typeof scoped === 'object'
    ? scoped
    : {ok: false, reason: 'verify output missing'};
  return {
    ...summary,
    doc: {
      schemaVersion: 1,
      summary,
      stores: [{
        storeKey: 'ordinary-approved-scope',
        results: [summary],
      }],
    },
  };
}
