const EXPLICIT_TERMINAL_CLASSIFICATIONS = new Set([
  'login_terminal_blocker',
  'inventory_transaction_restore_failed',
  'submitted_without_exact_readback',
]);

export function highClickItemKey(row = {}) {
  return `${String(row.storeKey || row.store || '').trim().toUpperCase()}::${String(row.skc || '').trim().toLowerCase()}`;
}
export function isHighClickResultSettled(row = {}) {
  if (row.ok === true) return true;
  return row.terminal === true && EXPLICIT_TERMINAL_CLASSIFICATIONS.has(String(row.classification || ''));
}

export function classifyHighClickRestoreResult(restored = {}) {
  if (restored.ok === true) {
    return {settled: true, terminal: false, classification: 'completed', writeAttempted: Boolean(restored.writeAttempted)};
  }

  const inventory = restored.inventoryTransaction || {};
  const writeAttempted = restored.writeAttempted === true
    || inventory.writeAttempted === true
    || inventory.submitAttempted === true
    || restored.transaction?.writeAttempted === true;
  const classification = String(restored.classification || '');
  const status = String(restored.status || '');

  if (classification === 'login_terminal_blocker' || restored.loginRecovery?.terminal === true) {
    return {settled: true, terminal: true, classification: 'login_terminal_blocker', writeAttempted};
  }
  if (status === 'inventory_transaction_restore_failed' || classification === 'inventory_transaction_restore_failed') {
    return {settled: true, terminal: true, classification: 'inventory_transaction_restore_failed', writeAttempted: true};
  }
  if (writeAttempted) {
    return {settled: true, terminal: true, classification: 'submitted_without_exact_readback', writeAttempted: true};
  }
  return {settled: false, terminal: false, classification: 'recoverable_pending', writeAttempted: false};
}

export function planHighClickStageResume({entries = [], previousResults = [], currentRunId = ''} = {}) {
  const priorByKey = new Map(previousResults.map(row => [highClickItemKey(row), row]));
  const settledByKey = new Map();
  const pending = [];
  const eligible = [];

  for (const entry of entries) {
    const key = highClickItemKey(entry);
    const prior = priorByKey.get(key);
    if (prior && isHighClickResultSettled(prior)) {
      settledByKey.set(key, prior);
      continue;
    }
    pending.push(entry);
    const attemptedInThisRun = Boolean(currentRunId)
      && prior?.classification === 'recoverable_pending'
      && String(prior?.attemptRunId || '') === String(currentRunId);
    if (!attemptedInThisRun) eligible.push(entry);
  }

  return {
    priorByKey,
    settledByKey,
    pending,
    eligible,
    deferredSameRun: pending.length > 0 && eligible.length === 0,
  };
}
