function normalizeStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

export function splitStoreKeys(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,\s，、]+/);
  return [...new Set(source.map(normalizeStoreKey).filter(Boolean))];
}

function validBusinessDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function timestampMs(value) {
  const text = String(value || '').trim();
  const systemd = /^\w{3}\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})(?:\s+\w+)?$/.exec(text);
  const parsed = Date.parse(systemd ? `${systemd[1]}T${systemd[2]}+08:00` : text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function planManualLoginLinkRecovery({partialState, storeKey} = {}) {
  const store = normalizeStoreKey(storeKey);
  const date = validBusinessDate(partialState?.date);
  const failedStores = splitStoreKeys(partialState?.failedStores);
  if (!store) return {required: false, reason: 'store_missing'};
  if (!partialState || typeof partialState !== 'object') return {required: false, reason: 'partial_state_missing'};
  if (!date) return {required: false, reason: 'partial_date_invalid'};
  if (!failedStores.includes(store)) {
    return {required: false, reason: 'store_not_in_partial_failure', date, failedStores};
  }
  return {
    required: true,
    reason: 'failed_store_login_recovered',
    storeKey: store,
    date,
    failedStores,
    priorLogFile: String(partialState.logFile || ''),
  };
}

function successfulManualSession(session, afterMs) {
  const completedAtMs = timestampMs(session?.completedAt);
  return (
    session?.status === 'completed'
    && Number.isFinite(completedAtMs)
    && completedAtMs > afterMs
    && session?.finish?.export?.ok === true
    && session?.finish?.probe?.ok === true
  );
}

export function assessSessionManagerManualRecovery({sessionReport, manualLoginState, unitStatus} = {}) {
  const failedStores = splitStoreKeys(sessionReport?.summary?.failedStores || sessionReport?.failedStores);
  const reportAtMs = timestampMs(sessionReport?.generatedAt || sessionReport?.endedAt);
  const unitExitAtMs = timestampMs(unitStatus?.ExecMainExitTimestamp || unitStatus?.StateChangeTimestamp);
  const recoveryBoundaryMs = Math.max(
    Number.isFinite(reportAtMs) ? reportAtMs : 0,
    Number.isFinite(unitExitAtMs) ? unitExitAtMs : 0,
  );
  if (!sessionReport || typeof sessionReport !== 'object') {
    return {recovered: false, reason: 'session_report_missing', failedStores};
  }
  if (sessionReport.ok === true && !failedStores.length) {
    if (!Number.isFinite(reportAtMs) || reportAtMs <= (Number.isFinite(unitExitAtMs) ? unitExitAtMs : 0)) {
      return {recovered: false, reason: 'successful_report_not_newer_than_unit_failure', failedStores};
    }
    return {
      recovered: true,
      reason: 'newer_successful_session_report',
      failedStores: [],
      recoveredStores: [],
      verifiedAt: sessionReport.generatedAt || sessionReport.endedAt || null,
    };
  }
  if (!failedStores.length) return {recovered: false, reason: 'failed_stores_missing', failedStores};
  if (!Number.isFinite(reportAtMs)) return {recovered: false, reason: 'session_report_time_invalid', failedStores};

  const sessions = Array.isArray(manualLoginState?.sessions) ? manualLoginState.sessions : [];
  const recoveredStores = [];
  let verifiedAt = '';
  for (const storeKey of failedStores) {
    const match = sessions
      .filter(session => normalizeStoreKey(session?.storeKey) === storeKey && successfulManualSession(session, recoveryBoundaryMs))
      .sort((a, b) => timestampMs(b.completedAt) - timestampMs(a.completedAt))[0];
    if (!match) {
      return {
        recovered: false,
        reason: 'failed_store_not_manually_recovered',
        failedStores,
        recoveredStores,
        missingStore: storeKey,
      };
    }
    recoveredStores.push(storeKey);
    if (!verifiedAt || timestampMs(match.completedAt) > timestampMs(verifiedAt)) verifiedAt = match.completedAt;
  }
  return {
    recovered: true,
    reason: 'all_failed_stores_manually_recovered',
    failedStores,
    recoveredStores,
    verifiedAt: verifiedAt || null,
  };
}

export function assessLinkRecoveryCompletion({successState, partialState, plan, startedAt} = {}) {
  const date = validBusinessDate(plan?.date);
  const storeKey = normalizeStoreKey(plan?.storeKey);
  const startedAtMs = Date.parse(startedAt || '');
  const successAtMs = Date.parse(successState?.generatedAt || '');
  const successStores = splitStoreKeys(successState?.successfulStores);
  const failedStores = splitStoreKeys(successState?.failedStores);
  const partialDate = validBusinessDate(partialState?.date);
  const partialFailedStores = splitStoreKeys(partialState?.failedStores);
  const successIsNew = Number.isFinite(startedAtMs) && Number.isFinite(successAtMs) && successAtMs >= startedAtMs;
  const successMatches = (
    Boolean(date)
    && successState?.ok === true
    && String(successState?.date || '') === date
    && successIsNew
    && successStores.includes(storeKey)
    && failedStores.length === 0
    && successState?.metricReady === true
    && successState?.warehouseLoaded === true
  );
  const partialStillBlocks = partialDate === date && partialFailedStores.includes(storeKey);
  return {
    complete: successMatches && !partialStillBlocks,
    reason: !successMatches
      ? 'complete_success_state_missing'
      : partialStillBlocks
        ? 'partial_state_still_blocks_store'
        : 'verified_complete',
    successStores,
    partialFailedStores,
  };
}
