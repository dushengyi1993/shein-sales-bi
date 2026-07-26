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
  const factUpdatedAtMs = instant(snapshot.factUpdatedAt);
  const metaRefreshedAtMs = instant(snapshot.metaRefreshedAt);
  const costRunCompletedAtMs = instant(snapshot.costRunCompletedAt);
  const costRunSourceCutoffAtMs = instant(snapshot.costRunSourceCutoffAt);
  const costAssignmentPostCutoverRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverRows || 0) || 0);
  const costAssignmentPostCutoverAssignedRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverAssignedRows || 0) || 0);
  const costAssignmentPostCutoverMissingRows = Math.max(0, Number(snapshot.costAssignmentPostCutoverMissingRows || 0) || 0);
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
  const coversFactChanges = factUpdatedAtMs === null
    || (metaRefreshedAtMs !== null && metaRefreshedAtMs >= factUpdatedAtMs);
  // A profit refresh is valid only when the completed moving-average ledger
  // saw every latest order mutation. Otherwise it can publish rows whose
  // revenue is current but whose cost assignment is from an older ledger.
  const coversCostRun = factUpdatedAtMs === null || (
    costRunCompletedAtMs !== null
    && costRunSourceCutoffAtMs !== null
  );
  const coversCostCutoff = factUpdatedAtMs === null
    || (costRunSourceCutoffAtMs !== null && costRunSourceCutoffAtMs >= factUpdatedAtMs);
  const costAssignmentCoverageRate = costAssignmentPostCutoverRows > 0
    ? costAssignmentPostCutoverAssignedRows / costAssignmentPostCutoverRows
    : 1;
  const coversCostAssignments = !costAssignmentCoverageRequired
    || (
      costAssignmentPostCutoverMissingRows === 0
      && costAssignmentPostCutoverAssignedRows >= costAssignmentPostCutoverRows
    );
  return Object.freeze({
    fresh: coversOrders && coversCore && coversFactChanges && coversCostRun && coversCostCutoff && coversCostAssignments,
    coversOrders,
    coversCore,
    coversFactChanges,
    coversCostRun,
    coversCostCutoff,
    coversCostAssignments,
    factOrderMax,
    profitCacheMax,
    profitCacheRows,
    factUpdatedAtMs,
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
