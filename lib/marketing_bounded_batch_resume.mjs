export function isResumableFallbackResult(result) {
  if (result?.ok === true) return true;
  const status = String(result?.status || '');
  const classification = String(result?.classification || '');
  if (status === 'inventory_admission_scope_blocked') {
    const transaction = result?.inventoryTransaction;
    return result?.terminalBlocked === true
      && transaction?.currentTransactionUnsubmitted === true
      && transaction?.writeAttempted === false
      && transaction?.submitAttempted === false
      && transaction?.remoteMutationStarted === false;
  }
  const activityId = Number(result?.createdActivityId || 0);
  const covered = result?.execute?.result?.desiredCoveredSkcs;
  const resumableExecutedSubset = status.startsWith('executed_subset_')
    && activityId > 0
    && Array.isArray(covered)
    && covered.length > 0;
  const blockedSkcs = result?.blocked?.blockedSkcs;
  const resumableTerminalBlocker = result?.blocked?.type === 'platform_or_inventory_blocked'
    && Array.isArray(blockedSkcs)
    && blockedSkcs.length > 0;
  const resumableInventoryRestoreFailed = status === 'inventory_transaction_restore_failed'
    || classification === 'inventory_transaction_restore_failed'
    || result?.blocked?.type === 'inventory_transaction_restore_failed';
  return resumableExecutedSubset
    || resumableTerminalBlocker
    || resumableInventoryRestoreFailed;
}

export function fallbackBatchExitCode({failedCount = 0, deferredCount = 0} = {}) {
  if (Number(failedCount) > 0) return 2;
  if (Number(deferredCount) > 0) return 3;
  return 0;
}

export function countBlockedFallbackTargets(results = []) {
  const blocked = new Set();
  for (const result of results) {
    const storeKey = String(result?.storeKey || '').trim().toUpperCase();
    const explicit = result?.blocked?.blockedSkcs;
    const inventory = result?.inventoryBlockedSkcs;
    const skcs = Array.isArray(explicit) && explicit.length
      ? explicit
      : Array.isArray(inventory) && inventory.length
        ? inventory
        : result?.blocked
          ? result?.targetSkcs || []
          : [];
    for (const skc of skcs) blocked.add(`${storeKey}::${String(skc || '').trim().toLowerCase()}`);
  }
  return blocked.size;
}
