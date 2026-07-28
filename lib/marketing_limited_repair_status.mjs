function positiveCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function increment(target, key, count = 1) {
  const normalizedKey = String(key || '').trim() || 'UNKNOWN';
  target[normalizedKey] = (target[normalizedKey] || 0) + positiveCount(count || 1);
}

function resultCount(result) {
  return positiveCount(result?.targetCount)
    || (Array.isArray(result?.targetSkcs) ? result.targetSkcs.length : 0)
    || 1;
}

function executedResultCount(result) {
  return positiveCount(result?.execute?.result?.targetCountForCreate)
    || positiveCount(result?.execute?.result?.targetCount)
    || positiveCount(result?.execute?.parsed?.targetCountForCreate)
    || resultCount(result);
}

function blockedResultCount(result) {
  return (Array.isArray(result?.inventoryBlockedSkcs) ? result.inventoryBlockedSkcs.length : 0)
    || (Array.isArray(result?.blocked?.blockedSkcs) ? result.blocked.blockedSkcs.length : 0)
    || resultCount(result);
}

function blockedReason(result) {
  for (const topUp of result?.inventoryTopUps || []) {
    const decision = topUp?.execute?.decision
      || topUp?.execute?.initialDecision
      || topUp?.dryRun?.decision
      || topUp?.dryRun?.initialDecision;
    if (decision?.reason) return String(decision.reason);
  }
  return String(result?.blocked?.reason || result?.status || 'blocked');
}

export function normalizeLimitedRepairResult(doc = {}) {
  const modernResults = Array.isArray(doc?.results) && doc?.totals && typeof doc.totals === 'object';
  if (!modernResults) {
    return {
      initialGap: positiveCount(doc?.initialGap),
      executedCount: positiveCount(doc?.executedCount),
      blockedCount: positiveCount(doc?.blockedCount),
      remainingGapByAfterScan: positiveCount(doc?.remainingGapByAfterScan)
        || (Array.isArray(doc?.remaining) ? doc.remaining.length : 0),
      afterLimitedRows: positiveCount(doc?.afterLimitedRows),
      byStoreExec: doc?.byStoreExec && typeof doc.byStoreExec === 'object' ? doc.byStoreExec : {},
      byStoreBlocked: doc?.byStoreBlocked && typeof doc.byStoreBlocked === 'object' ? doc.byStoreBlocked : {},
      reasonSummary: doc?.reasonSummary && typeof doc.reasonSummary === 'object' ? doc.reasonSummary : {},
      executedSamples: Array.isArray(doc?.executed) ? doc.executed.slice(0, 10) : [],
      blockedSamples: Array.isArray(doc?.blocked) ? doc.blocked.slice(0, 10) : [],
    };
  }

  const executed = doc.results.filter(result => /^executed(?:_|$)/i.test(String(result?.status || '')));
  const blocked = doc.results.filter(result => Boolean(result?.blocked) || /block/i.test(String(result?.status || '')));
  const byStoreExec = {};
  const byStoreBlocked = {};
  const reasonSummary = {};
  for (const result of executed) increment(byStoreExec, result.storeKey, executedResultCount(result));
  for (const result of blocked) {
    const count = blockedResultCount(result);
    increment(byStoreBlocked, result.storeKey, count);
    increment(reasonSummary, blockedReason(result), count);
  }

  const blockedCount = positiveCount(doc.totals.blockedTargetCount)
    || blocked.reduce((sum, result) => sum + resultCount(result), 0);
  const deferredCount = positiveCount(doc.deferredGroups);
  return {
    initialGap: positiveCount(doc.totals.planActionable),
    executedCount: positiveCount(doc.totals.executedTargetCount)
      || executed.reduce((sum, result) => sum + executedResultCount(result), 0),
    blockedCount,
    remainingGapByAfterScan: blockedCount + deferredCount,
    afterLimitedRows: 0,
    byStoreExec,
    byStoreBlocked,
    reasonSummary,
    executedSamples: executed.slice(0, 10),
    blockedSamples: blocked.slice(0, 10),
  };
}
