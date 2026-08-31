const DEFAULT_CORE_SKEW_MS = 15 * 60 * 1000;

function instant(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

/**
 * The refresh pipeline builds profit marts before it publishes the new portal
 * core. A mart timestamp slightly earlier than core.generatedAt is therefore
 * expected and must not trigger an immediate duplicate rebuild.
 */
export function evaluateProfitMartCacheFreshness(snapshot = {}, options = {}) {
  const factOrderMax = dateOnly(snapshot.factOrderMax);
  const profitCacheMax = dateOnly(snapshot.profitCacheMax);
  const profitCacheRows = Number(snapshot.profitCacheRows || 0);
  // Order mutations and other accounting inputs have different repair costs.
  // A sale/cancellation must rebuild the moving-average ledger before profit,
  // while a return/after-sales mutation only needs the profit cache rebuilt.
  // Keep factUpdatedAt as a backward-compatible fallback for older callers.
  const orderFactUpdatedAtMs = instant(snapshot.orderFactUpdatedAt ?? snapshot.factUpdatedAt);
  const accountingInputUpdatedAtMs = instant(
    snapshot.accountingInputUpdatedAt
      ?? snapshot.orderFactUpdatedAt
      ?? snapshot.factUpdatedAt
  );
  const metaRefreshedAtMs = instant(snapshot.metaRefreshedAt);
  const costRunCompletedAtMs = instant(snapshot.costRunCompletedAt);
  const costRunSourceCutoffAtMs = instant(snapshot.costRunSourceCutoffAt);
  const costAssignmentPostCutoverRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverRows || 0) || 0);
  const costAssignmentPostCutoverAssignedRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverAssignedRows || 0) || 0);
  const costAssignmentPostCutoverMissingRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverMissingRows || 0) || 0);
  const costAssignmentCutoffRows = snapshot.costAssignmentCutoffRows !== undefined
    ? Math.max(0, Number(snapshot.costAssignmentCutoffRows || 0) || 0)
    : null;
  const costAssignmentCutoffAssignedRows = snapshot.costAssignmentCutoffAssignedRows !== undefined
    ? Math.max(0, Number(snapshot.costAssignmentCutoffAssignedRows || 0) || 0)
    : null;
  const costAssignmentCutoffMissingRows = snapshot.costAssignmentCutoffMissingRows !== undefined
    ? Math.max(0, Number(snapshot.costAssignmentCutoffMissingRows || 0) || 0)
    : null;
  const costAssignmentPendingFollowUpRows = Math.max(0, Number(snapshot.costAssignmentPendingFollowUpRows || 0) || 0);
  const costAssignmentCoverageRequired = Boolean(snapshot.costAssignmentCoverageRequired);
  const coreGeneratedAtMs = instant(options.coreGeneratedAt);
  const allowedCoreSkewMs = Math.max(
    0,
    Number(options.allowedCoreSkewMs ?? DEFAULT_CORE_SKEW_MS) || 0,
  );
  const coversOrders = Boolean(
    profitCacheRows > 0
    && factOrderMax
    && profitCacheMax
    && profitCacheMax >= factOrderMax
  );
  const coversCore = coreGeneratedAtMs === null
    || (
      metaRefreshedAtMs !== null
      && metaRefreshedAtMs >= coreGeneratedAtMs - allowedCoreSkewMs
    );
  const coversFactChanges = accountingInputUpdatedAtMs === null
    || (metaRefreshedAtMs !== null && metaRefreshedAtMs >= accountingInputUpdatedAtMs);
  // A profit refresh is valid only when the completed moving-average ledger
  // saw every latest order mutation. Otherwise it can publish rows whose
  // revenue is current but whose cost assignment is from an older ledger.
  const coversCostRun = orderFactUpdatedAtMs === null || (
    costRunCompletedAtMs !== null
    && costRunSourceCutoffAtMs !== null
  );
  const coversCostCutoff = orderFactUpdatedAtMs === null
    || (costRunSourceCutoffAtMs !== null && costRunSourceCutoffAtMs >= orderFactUpdatedAtMs);
  const costAssignmentCoverageRate = costAssignmentPostCutoverRows > 0
    ? costAssignmentPostCutoverAssignedRows / costAssignmentPostCutoverRows
    : 1;
  const coversCostAssignments = !costAssignmentCoverageRequired || (
    costAssignmentCutoffRows !== null
      ? (costAssignmentCutoffMissingRows === 0 && costAssignmentCutoffAssignedRows >= costAssignmentCutoffRows)
      : (costAssignmentPostCutoverMissingRows === 0 && costAssignmentPostCutoverAssignedRows >= costAssignmentPostCutoverRows)
  );
  const followUpPending = Boolean(
    coversCostRun
    && (
      (orderFactUpdatedAtMs !== null && costRunSourceCutoffAtMs !== null && costRunSourceCutoffAtMs < orderFactUpdatedAtMs)
      || costAssignmentPendingFollowUpRows > 0
    )
  );
  const usableSnapshot = Boolean(
    coversOrders
    && coversCore
    && coversFactChanges
    && coversCostRun
    && coversCostAssignments
  );
  return Object.freeze({
    fresh: usableSnapshot && coversCostCutoff && !followUpPending,
    usableSnapshot,
    followUpPending,
    pendingFollowUpRows: costAssignmentPendingFollowUpRows,
    costAssignmentPendingFollowUpRows,
    costAssignmentCutoffRows,
    costAssignmentCutoffAssignedRows,
    costAssignmentCutoffMissingRows,
    coversOrders,
    coversCore,
    coversFactChanges,
    coversCostRun,
    coversCostCutoff,
    coversCostAssignments,
    factOrderMax,
    profitCacheMax,
    profitCacheRows,
    // factUpdatedAtMs remains an alias for callers that display the old field.
    factUpdatedAtMs: orderFactUpdatedAtMs,
    orderFactUpdatedAtMs,
    accountingInputUpdatedAtMs,
    metaRefreshedAtMs,
    costRunCompletedAtMs,
    costRunSourceCutoffAtMs,
    costAssignmentPostCutoverRows,
    costAssignmentPostCutoverAssignedRows,
    costAssignmentPostCutoverMissingRows,
    costAssignmentCoverageRequired,
    costAssignmentCoverageRate,
    coreGeneratedAtMs,
    allowedCoreSkewMs,
  });
}

export const PROFIT_MART_CORE_SKEW_MS = DEFAULT_CORE_SKEW_MS;
