const PRODUCT_RECONCILIATION_WARNING = /^([A-Z0-9]+) 店商品对账需处理：/u;

function productRow(result) {
  return result?.semanticReconciliation
    || (Array.isArray(result?.load?.reconciliation) ? result.load.reconciliation[0] : null)
    || result?.reconciliation
    || null;
}

function productWarning(storeKey, row) {
  const warnings = Array.isArray(row?.warnings)
    ? row.warnings
    : String(row?.warnings || '').split(/[；;]+/u);
  const text = warnings.map(value => String(value || '').trim()).filter(Boolean).join('；');
  return text ? `${storeKey} 店商品对账需处理：${text}` : '';
}

function productRowHealthy(result, row) {
  const stockMissing = Number(row?.counts?.stockMissing ?? row?.stock_missing_count ?? row?.stockMissingCount);
  return result?.ok === true
    && String(result?.status || row?.status || '') === 'matched'
    && Number.isFinite(stockMissing)
    && stockMissing === 0
    && !productWarning(String(result?.storeKey || '').trim().toUpperCase(), row);
}

/**
 * Replace only product-reconciliation reminders when a newer, complete and
 * fresh all-store report is available. Other audit findings remain untouched.
 * Incomplete or stale evidence leaves the generated core fail-closed.
 */
export function overlayCurrentProductReconciliationAudit(core, evidence, options = {}) {
  if (!core || typeof core !== 'object') return core;
  const summary = evidence?.summary;
  const results = Array.isArray(summary?.results) ? summary.results : [];
  const counts = summary?.counts || {};
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = Math.max(60_000, Number(options.maxAgeMs ?? 6 * 60 * 60 * 1000));
  const summaryMs = Date.parse(summary?.generatedAt || '');
  const coreMs = Date.parse(core?.audit?.generatedAt || core?.generatedAt || '');
  const expectedStores = [...new Set((options.expectedStores || summary?.reportScope?.expectedStores || [])
    .map(value => String(value || '').trim().toUpperCase()).filter(Boolean))].sort();
  const resultStores = results.map(result => String(result?.storeKey || '').trim().toUpperCase()).filter(Boolean);
  const uniqueResultStores = [...new Set(resultStores)].sort();
  const exactStoreCoverage = expectedStores.length > 0
    && resultStores.length === expectedStores.length
    && uniqueResultStores.length === expectedStores.length
    && uniqueResultStores.every((store, index) => store === expectedStores[index]);
  const currentEnough = Number.isFinite(summaryMs)
    && Number.isFinite(nowMs)
    && summaryMs >= nowMs - maxAgeMs
    && summaryMs <= nowMs + 5 * 60_000
    && (!Number.isFinite(coreMs) || summaryMs >= coreMs);
  const complete = evidence?.fresh === true
    && currentEnough
    && summary?.ok === true
    && summary?.reportScope?.complete === true
    && Number(counts.total) > 0
    && Number(counts.succeeded) === Number(counts.total)
    && Number(counts.failed || 0) === 0
    && results.length === Number(counts.total)
    && exactStoreCoverage;
  if (!complete) return core;

  const current = new Map();
  for (const result of results) {
    const storeKey = String(result?.storeKey || '').trim().toUpperCase();
    const row = productRow(result);
    if (!storeKey || !row) return core;
    current.set(storeKey, {
      healthy: productRowHealthy(result, row),
      warning: productWarning(storeKey, row),
    });
  }

  const audit = core.audit && typeof core.audit === 'object' ? core.audit : {};
  const oldWarnings = Array.isArray(audit.warningMessages) ? audit.warningMessages : [];
  const anonymousWarningCount = Math.max(0, Number(audit.warnings || 0) - oldWarnings.length);
  const nextWarnings = [];
  const representedStores = new Set();
  for (const messageValue of oldWarnings) {
    const message = String(messageValue || '').trim();
    const match = PRODUCT_RECONCILIATION_WARNING.exec(message);
    if (!match) {
      if (message) nextWarnings.push(message);
      continue;
    }
    const storeKey = match[1];
    const latest = current.get(storeKey);
    if (!latest) return core;
    representedStores.add(storeKey);
    if (!latest.healthy) nextWarnings.push(latest.warning || message);
  }
  for (const [storeKey, latest] of current) {
    if (!latest.healthy && latest.warning && !representedStores.has(storeKey)) {
      nextWarnings.push(latest.warning);
    }
  }

  const warningMessages = [...new Set(nextWarnings)];
  return {
    ...core,
    audit: {
      ...audit,
      warnings: anonymousWarningCount + warningMessages.length,
      warningMessages,
      liveProductReconciliationAt: String(summary.generatedAt || ''),
      liveProductReconciliationApplied: true,
    },
  };
}
