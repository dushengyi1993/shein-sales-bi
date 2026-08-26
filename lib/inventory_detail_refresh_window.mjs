export function inventoryDetailRefreshWindow({
  refreshStartedAt,
  detailFetchedAt,
  cacheGeneratedAt,
  refreshEndedAt,
} = {}) {
  const refreshStartedMs = Date.parse(String(refreshStartedAt || ''));
  const detailFetchedMs = Date.parse(String(detailFetchedAt || ''));
  const cacheGeneratedMs = Date.parse(String(cacheGeneratedAt || ''));
  const refreshEndedMs = Date.parse(String(refreshEndedAt || ''));
  const ok = Number.isFinite(refreshStartedMs)
    && Number.isFinite(detailFetchedMs)
    && Number.isFinite(cacheGeneratedMs)
    && Number.isFinite(refreshEndedMs)
    && refreshStartedMs <= detailFetchedMs
    && detailFetchedMs <= cacheGeneratedMs
    && cacheGeneratedMs <= refreshEndedMs;
  return Object.freeze({ok, refreshStartedMs, detailFetchedMs, cacheGeneratedMs, refreshEndedMs});
}
