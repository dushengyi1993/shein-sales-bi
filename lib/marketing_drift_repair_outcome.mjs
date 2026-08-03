const COMPLETED_STATUSES = new Set([
  'already_exactly_covered',
  'dry_run_transaction_locked',
  'dry_run_create_only',
  'protected_manual_special_skipped',
  'replaced_all',
]);

const TERMINAL_BUSINESS_BLOCK_STATUSES = new Set([
  'initial_platform_blocked_preserved',
  'inventory_transaction_or_enrollment_blocked',
  'platform_blocked_old_protection_restored',
]);

export function isCompletedDriftRepairResult(result) {
  if (result?.ok !== true) return false;
  if (result?.readback?.ok === true) return true;
  return COMPLETED_STATUSES.has(String(result?.status || ''));
}

export function isTerminalDriftBusinessBlock(result) {
  if (!TERMINAL_BUSINESS_BLOCK_STATUSES.has(String(result?.status || ''))) return false;
  if (String(result?.status || '') === 'inventory_transaction_or_enrollment_blocked') {
    return result?.inventoryTransaction?.writeAttempted !== true
      || result?.inventoryTransaction?.safe === true;
  }
  return result?.safe === true || result?.readback?.safe === true;
}

export function isSettledDriftRepairResult(result) {
  return isCompletedDriftRepairResult(result) || isTerminalDriftBusinessBlock(result);
}

export function summarizeDriftRepairOutcomes(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const completedGroups = rows.filter(isCompletedDriftRepairResult).length;
  const businessBlockedGroups = rows.filter(isTerminalDriftBusinessBlock).length;
  const failedGroups = Math.max(0, rows.length - completedGroups - businessBlockedGroups);
  const unsafeGroups = rows.filter(result => (
    String(result?.status || '') === 'unsafe_uncovered'
    || result?.safe === false
    || result?.readback?.safe === false
    || (
      result?.inventoryTransaction?.writeAttempted === true
      && result?.inventoryTransaction?.safe === false
    )
  )).length;
  return {completedGroups, businessBlockedGroups, failedGroups, unsafeGroups};
}

export function driftRepairBatchExitCode({failedGroups = 0, businessBlockedGroups = 0, deferredGroups = 0} = {}) {
  if (Number(failedGroups) > 0) return 2;
  if (Number(deferredGroups) > 0) return 3;
  if (Number(businessBlockedGroups) > 0) return 4;
  return 0;
}
