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
  const metaRefreshedAtMs = instant(snapshot.metaRefreshedAt);
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
  return Object.freeze({
    fresh: coversOrders && coversCore,
    coversOrders,
    coversCore,
    factOrderMax,
    profitCacheMax,
    profitCacheRows,
    metaRefreshedAtMs,
    coreGeneratedAtMs,
    allowedCoreSkewMs,
  });
}

export const PROFIT_MART_CORE_SKEW_MS = DEFAULT_CORE_SKEW_MS;
