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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function addDaysText(dateText, offsetDays) {
  const [y, m, d] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
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

/**
 * Fail-closed fallback planner used when the canonical
 * state/cloud_ops_alerts/link-business-last-partial.json is absent because the
 * morning-chain fetch-only/chunk failure exited before the global partial was
 * created.
 *
 * Accepts ONLY authoritative same-run morning chunk evidence:
 * - latestState must be the same-day pair (date=runDate, businessDate=runDate-1)
 *   and either terminally failed, or stale-running while systemd proves the
 *   morning service inactive and newer chunk evidence supersedes latest;
 * - every considered chunk must carry businessDate === runDate - 1 and a
 *   partial status (warning/failed/partial/running); a 'done' chunk must have
 *   no failed stores, resume-evidence documents are inert;
 * - per store, the unique latest chunk timestamp decides its conclusion;
 *   equal latest timestamps with conflicting conclusions reject the fallback,
 *   and numeric retry ordering is only a deterministic tie-breaker for
 *   non-conflicting evidence;
 * - the resulting per-store evidence must exactly equal the enabled store
 *   set, and the combined failed set must be non-empty and contain the
 *   requested store.
 *
 * Any missing/malformed/stale/cross-day/inexact evidence refuses recovery.
 */
const FALLBACK_ACCEPTED_STATUSES = new Set(['warning', 'failed', 'partial', 'running']);
const FALLBACK_RESUME_SCHEMA = 'shein-morning-resume-evidence/v1';

function chunkRetryIndex(name) {
  const match = /-retry-(\d+)\.json$/.exec(String(name || ''));
  return match ? Number(match[1]) : 0;
}

export function planManualLoginLinkRecoveryFromMorningChunks({
  storeKey,
  runDate,
  chunkDocuments = [],
  enabledStores = [],
  latestState = null,
  morningServiceActive = null,
} = {}) {
  const store = normalizeStoreKey(storeKey);
  const runDateText = validBusinessDate(runDate);
  const expectedStores = [...new Set(enabledStores.map(normalizeStoreKey).filter(Boolean))].sort();
  if (!store) return {required: false, reason: 'store_missing'};
  if (!runDateText) return {required: false, reason: 'fallback_run_date_invalid'};
  if (!expectedStores.length) return {required: false, reason: 'fallback_enabled_stores_missing'};
  if (!latestState || typeof latestState !== 'object') {
    return {required: false, reason: 'fallback_run_state_missing'};
  }

  const businessDate = addDaysText(runDateText, -1);
  if (
    String(latestState.date || '') !== runDateText
    || String(latestState.businessDate || '') !== businessDate
  ) {
    return {
      required: false,
      reason: 'fallback_run_pair_mismatch',
      runDate: runDateText,
      businessDate,
      latestDate: String(latestState.date || ''),
      latestBusinessDate: String(latestState.businessDate || ''),
    };
  }
  const runStatus = String(latestState.status || '').trim();
  const staleRunningRecovery = runStatus === 'running' && morningServiceActive === false;
  if (runStatus !== 'failed' && !staleRunningRecovery) {
    return {required: false, reason: 'fallback_run_status_not_terminal_failure', runStatus};
  }
  if (!Array.isArray(chunkDocuments) || !chunkDocuments.length) {
    return {required: false, reason: 'fallback_no_chunks'};
  }

  // storeKey -> [{status: 'success'|'failed', generatedMs, retryIndex, chunkFile}]
  const storeConclusions = new Map();
  const chunkFiles = [];
  let newestEntry = null;
  let sawChunk = false;
  for (const entry of chunkDocuments) {
    const name = String(entry?.name || '');
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') {
      return {required: false, reason: 'fallback_chunk_malformed', chunkFile: name};
    }
    sawChunk = true;
    if (String(payload.schemaVersion || '') === FALLBACK_RESUME_SCHEMA) {
      // Resume-evidence documents are not failure ledgers and therefore cannot
      // seed or mutate canonical partial state.
      continue;
    }
    if (validBusinessDate(payload.date) !== businessDate) {
      return {
        required: false,
        reason: 'fallback_chunk_date_mismatch',
        chunkFile: name,
        chunkDate: String(payload.date || ''),
        businessDate,
      };
    }
    const status = String(payload.status || '').trim();
    const successList = payload.successfulStores;
    const failedList = payload.failedStores;
    if (successList !== undefined && !Array.isArray(successList)) {
      return {required: false, reason: 'fallback_chunk_malformed', chunkFile: name};
    }
    if (failedList !== undefined && !Array.isArray(failedList)) {
      return {required: false, reason: 'fallback_chunk_malformed', chunkFile: name};
    }
    const chunkSuccess = splitStoreKeys(successList);
    const chunkFailed = splitStoreKeys(failedList);
    if (chunkSuccess.some(item => chunkFailed.includes(item))) {
      return {required: false, reason: 'fallback_chunk_store_conflict', chunkFile: name};
    }
    const generatedMs = timestampMs(payload.generatedAt);
    if (!Number.isFinite(generatedMs)) {
      return {required: false, reason: 'fallback_chunk_time_invalid', chunkFile: name};
    }
    const retryIndex = chunkRetryIndex(name);
    const addConclusions = (items, status) => {
      for (const item of items) {
        const list = storeConclusions.get(item) || [];
        list.push({status, generatedMs, retryIndex, chunkFile: name});
        storeConclusions.set(item, list);
      }
    };
    if (status === 'done') {
      if (chunkFailed.length) {
        return {required: false, reason: 'fallback_chunk_status_inconsistent', chunkFile: name};
      }
      addConclusions(chunkSuccess, 'success');
      continue;
    }
    if (!FALLBACK_ACCEPTED_STATUSES.has(status)) {
      return {required: false, reason: 'fallback_chunk_status_invalid', chunkFile: name, status};
    }
    addConclusions(chunkSuccess, 'success');
    addConclusions(chunkFailed, 'failed');
    chunkFiles.push(name);
    if (!newestEntry || generatedMs > newestEntry.generatedMs
      || (generatedMs === newestEntry.generatedMs && retryIndex > newestEntry.retryIndex)) {
      newestEntry = {generatedMs, retryIndex, logFile: String(payload.logFile || '')};
    }
  }
  if (!sawChunk) return {required: false, reason: 'fallback_no_chunks'};
  if (!chunkFiles.length) {
    // Only done/resume documents: there is no partial failure evidence.  If
    // the completed evidence exactly covers the enabled set the run is simply
    // done; anything else is unusable for recovery.
    const combinedStores = [...storeConclusions.keys()].sort();
    if (
      combinedStores.length === expectedStores.length
      && combinedStores.every((item, index) => item === expectedStores[index])
    ) {
      return {required: false, reason: 'fallback_no_failed_stores', successStores: combinedStores};
    }
    return {required: false, reason: 'fallback_no_partial_chunks'};
  }

  if (staleRunningRecovery) {
    const latestMs = timestampMs(latestState.generatedAt);
    if (!Number.isFinite(latestMs) || newestEntry.generatedMs <= latestMs) {
      return {required: false, reason: 'fallback_stale_running_not_superseded'};
    }
  }

  const success = new Set();
  const failed = new Set();
  for (const [item, conclusions] of storeConclusions) {
    const maxMs = Math.max(...conclusions.map(conclusion => conclusion.generatedMs));
    const tiedLatest = conclusions.filter(conclusion => conclusion.generatedMs === maxMs);
    const kinds = new Set(tiedLatest.map(conclusion => conclusion.status));
    if (kinds.size > 1) {
      // Equal chunk timestamps with conflicting per-store conclusions cannot
      // be ordered by time; rejecting is the only fail-closed answer.
      return {
        required: false,
        reason: 'fallback_chunk_conflict',
        storeKey: item,
        chunkFiles: [...new Set(tiedLatest.map(conclusion => conclusion.chunkFile))],
      };
    }
    // Non-conflicting evidence: numeric retry ordering is the deterministic
    // tie-breaker when timestamps are equal.
    const winner = tiedLatest.slice().sort((a, b) => b.retryIndex - a.retryIndex)[0];
    (winner.status === 'success' ? success : failed).add(item);
  }

  const combinedStores = [...new Set([...success, ...failed])].sort();
  if (
    combinedStores.length !== expectedStores.length
    || combinedStores.some((item, index) => item !== expectedStores[index])
  ) {
    return {
      required: false,
      reason: 'fallback_store_set_mismatch',
      combinedStores,
      enabledStores: expectedStores,
    };
  }
  const failedStores = [...failed].sort();
  const successStores = [...success].sort();
  if (!failedStores.length) {
    return {required: false, reason: 'fallback_no_failed_stores', successStores};
  }
  if (!failedStores.includes(store)) {
    return {
      required: false,
      reason: 'store_not_in_fallback_failure',
      date: businessDate,
      failedStores,
    };
  }
  return {
    required: true,
    reason: 'morning_chunk_partial_recovery',
    storeKey: store,
    date: businessDate,
    runDate: runDateText,
    failedStores,
    successStores,
    enabledStores: expectedStores,
    chunkFiles,
    logFile: newestEntry.logFile,
  };
}

/**
 * Canonical link-business-last-partial.json payload builder used to atomically
 * seed/merge the partial before queueing a recovery derived from morning-chunk
 * evidence.  Success wins over failure for a store that appears in both sets,
 * and an existing same-date partial is merged instead of overwritten.
 */
export function mergeLinkBusinessPartialState({
  existing = null,
  date,
  failedStores = [],
  successStores = [],
  logFile = '',
  generatedAt,
  recoveryRunId,
} = {}) {
  const dateText = validBusinessDate(date);
  const success = new Set(splitStoreKeys(existing?.successStores));
  const failed = new Set(splitStoreKeys(existing?.failedStores));
  if (!(existing && validBusinessDate(existing.date) === dateText)) {
    success.clear();
    failed.clear();
  }
  for (const store of splitStoreKeys(successStores)) {
    success.add(store);
    failed.delete(store);
  }
  for (const store of splitStoreKeys(failedStores)) {
    failed.add(store);
    success.delete(store);
  }
  return {
    date: dateText,
    generatedAt: generatedAt ? new Date(generatedAt).toISOString() : new Date().toISOString(),
    failedStores: [...failed].sort().join(' '),
    successStores: [...success].sort().join(' '),
    logFile: String(logFile || existing?.logFile || ''),
    recoveryRunId: recoveryRunId !== undefined ? String(recoveryRunId) : String(existing?.recoveryRunId || ''),
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

export function assessLinkRecoveryCompletion({successState, partialState, plan, startedAt, attempt = null} = {}) {
  const date = validBusinessDate(plan?.date);
  const storeKey = normalizeStoreKey(plan?.storeKey);
  const startedAtMs = Date.parse(startedAt || '');
  const successAtMs = Date.parse(successState?.generatedAt || '');
  const successStores = splitStoreKeys(successState?.successfulStores);
  const failedStores = splitStoreKeys(successState?.failedStores);
  const partialDate = validBusinessDate(partialState?.date);
  const partialFailedStores = splitStoreKeys(partialState?.failedStores);
  const partialSuccessStores = splitStoreKeys(partialState?.successStores || partialState?.successfulStores);
  const partialGeneratedMs = timestampMs(partialState?.generatedAt);
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
  const partialNoLongerBlocks = Boolean(date) && partialDate === date
    && partialFailedStores.length > 0
    && !partialFailedStores.includes(storeKey)
    && partialSuccessStores.includes(storeKey);
  // completed_pending_others is only accepted when the current attempt can
  // prove its own outcome: the command succeeded, the canonical partial was
  // rewritten during this attempt (generatedAt >= attemptStartedAt), the
  // bound attempt/run id matches, and the target store's exact-date evidence
  // files were verified.  Without an attempt context the legacy constraints
  // apply (backward compatible for the not_required early path).
  const commandOk = attempt ? Boolean(attempt.commandOk) : true;
  const partialFreshForAttempt = !attempt
    || (Number.isFinite(startedAtMs) && Number.isFinite(partialGeneratedMs) && partialGeneratedMs >= startedAtMs);
  const runIdMatches = !attempt?.recoveryRunId
    || String(partialState?.recoveryRunId || '') === String(attempt.recoveryRunId);
  const evidenceVerified = attempt ? Boolean(attempt.evidenceVerified) : true;
  const pendingConstraintsOk = commandOk && partialFreshForAttempt && runIdMatches && evidenceVerified;
  let reason;
  if (!successMatches) {
    if (partialNoLongerBlocks && !pendingConstraintsOk) {
      reason = !commandOk
        ? 'pending_others_command_failed'
        : !partialFreshForAttempt
          ? 'pending_others_partial_stale'
          : !runIdMatches
            ? 'pending_others_run_id_mismatch'
            : 'pending_others_evidence_missing';
    } else {
      reason = partialNoLongerBlocks ? 'store_removed_from_partial_pending_others' : 'complete_success_state_missing';
    }
  } else {
    reason = partialStillBlocks ? 'partial_state_still_blocks_store' : 'verified_complete';
  }
  return {
    complete: successMatches && !partialStillBlocks,
    pendingOthers: !successMatches && partialNoLongerBlocks && pendingConstraintsOk,
    storeRemovedFromPartial: partialNoLongerBlocks,
    attemptConstraints: attempt ? {commandOk, partialFreshForAttempt, runIdMatches, evidenceVerified} : null,
    reason,
    successStores,
    partialFailedStores,
  };
}
