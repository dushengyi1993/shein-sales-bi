export const DEADLINE_INVENTORY_RECOVERY_RESERVE_SEC = 900;
export const DEADLINE_FINALIZATION_RESERVE_SEC = DEADLINE_INVENTORY_RECOVERY_RESERVE_SEC;

export const TERMINAL_STACK_REVIEW_TIMEOUT_SEC = 900;
export const TERMINAL_STACK_REVIEW_KILL_AFTER_SEC = 60;
export const TERMINAL_PRICE_SCAN_TIMEOUT_SEC = 2400;
export const TERMINAL_PRICE_SCAN_KILL_AFTER_SEC = 60;
export const TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC = 180;
export const DEADLINE_TERMINAL_SNAPSHOT_BOUND_SEC = TERMINAL_STACK_REVIEW_TIMEOUT_SEC
  + TERMINAL_STACK_REVIEW_KILL_AFTER_SEC
  + TERMINAL_PRICE_SCAN_TIMEOUT_SEC
  + TERMINAL_PRICE_SCAN_KILL_AFTER_SEC
  + TERMINAL_SNAPSHOT_SAFETY_MARGIN_SEC;
export const DEADLINE_HOST_FINALIZATION_RESERVE_SEC = DEADLINE_INVENTORY_RECOVERY_RESERVE_SEC
  + DEADLINE_TERMINAL_SNAPSHOT_BOUND_SEC;

export const MARKETING_IMMEDIATE_MAX_OUTER_WINDOW_SEC = 6 * 3600;
export const MARKETING_REPAIR_SYSTEMD_STARTUP_MARGIN_SEC = 300;
export const MARKETING_REPAIR_NORMAL_OUTER_WINDOW_FROM_EARLIEST_START_SEC = (2 * 3600) + (25 * 60);
export const MARKETING_REPAIR_SYSTEMD_TIMEOUT_START_SEC = MARKETING_IMMEDIATE_MAX_OUTER_WINDOW_SEC
  + DEADLINE_HOST_FINALIZATION_RESERVE_SEC
  + MARKETING_REPAIR_SYSTEMD_STARTUP_MARGIN_SEC;

export class MarketingDeadlineError extends Error {
  constructor(message, code = 'MARKETING_DEADLINE_INVALID') {
    super(message);
    this.name = 'MarketingDeadlineError';
    this.code = code;
  }
}

function fail(message, code = 'MARKETING_DEADLINE_INVALID') {
  throw new MarketingDeadlineError(message, code);
}

export function normalizeDeadlineEpoch(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) fail(`${label} must be a positive Unix epoch second`);
  const epoch = Number(raw);
  if (!Number.isSafeInteger(epoch)) fail(`${label} is outside the safe integer range`);
  return epoch;
}

export function createDeadlineContract({
  gracefulCutoffEpoch,
  outerHardDeadlineEpoch,
  nowEpoch = Math.floor(Date.now() / 1000),
  minFinalizationBudgetSec = DEADLINE_FINALIZATION_RESERVE_SEC,
  required = false,
  allowExpiredOuter = false,
} = {}) {
  const hasGraceful = gracefulCutoffEpoch !== undefined && gracefulCutoffEpoch !== null
    && String(gracefulCutoffEpoch).trim() !== '';
  const hasOuter = outerHardDeadlineEpoch !== undefined && outerHardDeadlineEpoch !== null
    && String(outerHardDeadlineEpoch).trim() !== '';
  if (!hasGraceful && !hasOuter) {
    if (required) fail('graceful and outer hard deadlines are required', 'MARKETING_DEADLINE_REQUIRED');
    return null;
  }
  if (!hasGraceful || !hasOuter) fail('graceful and outer hard deadlines must be supplied together');
  const graceful = normalizeDeadlineEpoch(gracefulCutoffEpoch, 'gracefulCutoffEpoch');
  const outer = normalizeDeadlineEpoch(outerHardDeadlineEpoch, 'outerHardDeadlineEpoch');
  const now = normalizeDeadlineEpoch(nowEpoch, 'nowEpoch');
  const reserve = Number(minFinalizationBudgetSec);
  if (!Number.isSafeInteger(reserve) || reserve < DEADLINE_FINALIZATION_RESERVE_SEC) {
    fail(`minFinalizationBudgetSec must be an integer of at least ${DEADLINE_FINALIZATION_RESERVE_SEC}s`);
  }
  if (outer < graceful + reserve) {
    fail(`outerHardDeadlineEpoch must be at least ${reserve}s after gracefulCutoffEpoch`);
  }
  if (!allowExpiredOuter && outer <= now) {
    fail('outer hard deadline has already elapsed', 'MARKETING_DEADLINE_OUTER_EXPIRED');
  }
  return Object.freeze({
    gracefulCutoffEpoch: graceful,
    outerHardDeadlineEpoch: outer,
    minFinalizationBudgetSec: reserve,
  });
}

export function deadlineState(contract, nowEpoch = Math.floor(Date.now() / 1000)) {
  if (!contract) return {enabled: false, nowEpoch: Number(nowEpoch)};
  const now = normalizeDeadlineEpoch(nowEpoch, 'nowEpoch');
  return {
    enabled: true,
    nowEpoch: now,
    gracefulRemainingSec: contract.gracefulCutoffEpoch - now,
    outerRemainingSec: contract.outerHardDeadlineEpoch - now,
    gracefulClosed: now >= contract.gracefulCutoffEpoch,
    outerClosed: now >= contract.outerHardDeadlineEpoch,
    finalizationBudgetAvailable: contract.outerHardDeadlineEpoch - now >= contract.minFinalizationBudgetSec,
  };
}

export function assertCanStartUnit(contract, {
  nowEpoch = Math.floor(Date.now() / 1000),
  continuation = false,
  label = 'business unit',
} = {}) {
  const state = deadlineState(contract, nowEpoch);
  if (!state.enabled) return state;
  if (state.outerClosed) fail(`${label} cannot start after outer hard deadline`, 'MARKETING_DEADLINE_OUTER_EXPIRED');
  if (!continuation && state.gracefulClosed) {
    fail(`${label} cannot start after graceful cutoff`, 'MARKETING_DEADLINE_GRACEFUL_CUTOFF');
  }
  if (!continuation && !state.finalizationBudgetAvailable) {
    fail(`${label} cannot start without ${contract.minFinalizationBudgetSec}s for inventory restore and terminal readback`,
      'MARKETING_DEADLINE_OUTER_BUDGET');
  }
  return state;
}

export function assertBeforeOuter(contract, {
  nowEpoch = Math.floor(Date.now() / 1000),
  reserveSec = 0,
  label = 'business action',
} = {}) {
  const state = deadlineState(contract, nowEpoch);
  if (!state.enabled) return state;
  if (state.outerClosed) fail(`${label} cannot start after outer hard deadline`, 'MARKETING_DEADLINE_OUTER_EXPIRED');
  const reserve = Number(reserveSec);
  if (!Number.isSafeInteger(reserve) || reserve < 0) fail('reserveSec must be a non-negative safe integer');
  if (state.outerRemainingSec < reserve) {
    fail(`${label} cannot start without ${reserve}s for inventory restore and terminal readback`,
      'MARKETING_DEADLINE_OUTER_BUDGET');
  }
  return state;
}

export function boundedTimeoutMs(contract, {
  nowEpoch = Math.floor(Date.now() / 1000),
  reserveSec = 0,
  capMs = Number.POSITIVE_INFINITY,
  label = 'bounded operation',
} = {}) {
  const state = assertBeforeOuter(contract, {nowEpoch, label});
  if (!state.enabled) return Number.isFinite(capMs) ? Math.max(1, Math.floor(capMs)) : 0;
  const reserve = Number(reserveSec);
  if (!Number.isSafeInteger(reserve) || reserve < 0) fail('reserveSec must be a non-negative safe integer');
  const remainingMs = (contract.outerHardDeadlineEpoch - state.nowEpoch - reserve) * 1000;
  if (remainingMs <= 0) fail(`${label} has no bounded time before outer hard deadline`, 'MARKETING_DEADLINE_OUTER_BUDGET');
  const cap = Number.isFinite(capMs) ? Math.max(1, Math.floor(capMs)) : remainingMs;
  return Math.max(1, Math.min(remainingMs, cap));
}

export function boundedRecoveryTimeoutMs(contract, {
  nowEpoch = Math.floor(Date.now() / 1000),
  capMs = Number.POSITIVE_INFINITY,
  label = 'recovery operation',
} = {}) {
  const state = deadlineState(contract, nowEpoch);
  if (!state.enabled) return Number.isFinite(capMs) ? Math.max(1, Math.floor(capMs)) : 0;
  const remainingMs = (contract.outerHardDeadlineEpoch + contract.minFinalizationBudgetSec - state.nowEpoch) * 1000;
  if (remainingMs <= 0) fail(`${label} exceeded the bounded recovery window`, 'MARKETING_DEADLINE_RECOVERY_EXPIRED');
  const cap = Number.isFinite(capMs) ? Math.max(1, Math.floor(capMs)) : remainingMs;
  return Math.max(1, Math.min(remainingMs, cap));
}

export function deadlineBoundAdapterFactory(baseFactory, contract, {
  label = 'inventory transaction',
  nowEpoch = () => Math.floor(Date.now() / 1000),
} = {}) {
  if (typeof baseFactory !== 'function') throw new TypeError('baseFactory must be a function');
  const clock = () => typeof nowEpoch === 'function' ? nowEpoch() : nowEpoch;
  return async options => {
    assertBeforeOuter(contract, {nowEpoch: clock(), label: `${label} adapter creation`});
    const adapter = await baseFactory(options);
    return {
      ...adapter,
      async resolveTargets(targets) {
        assertBeforeOuter(contract, {nowEpoch: clock(), label: `${label} target resolution`});
        return await adapter.resolveTargets(targets);
      },
      async acquireLock(target) {
        assertBeforeOuter(contract, {nowEpoch: clock(), label: `${label} inventory lock`});
        const release = await adapter.acquireLock(target);
        return async () => await release();
      },
      async readStock(target) {
        // Once the transaction has acquired a lock, reads must remain available
        // to the transaction's finally/restore path even if outer has elapsed.
        return await adapter.readStock(target);
      },
      async writeStock(input) {
        const phase = String(input?.phase || 'write');
        if (phase !== 'restore') {
          assertBeforeOuter(contract, {
            nowEpoch: clock(),
            reserveSec: contract?.minFinalizationBudgetSec || 0,
            label: `${label} inventory ${phase}`,
          });
        }
        return await adapter.writeStock(input);
      },
    };
  };
}

export function isMarketingDeadlineError(error) {
  return error instanceof MarketingDeadlineError
    || String(error?.code || '').startsWith('MARKETING_DEADLINE_')
    || /(?:MARKETING_DEADLINE_|outer hard deadline|graceful cutoff|bounded recovery window)/i.test(String(error?.message || ''));
}

export async function findPersistedMarketingTransactionContinuation({
  root,
  storeKey,
  workFingerprint,
  rescuePath,
  journalDir = path.join(path.resolve(root), 'state', 'marketing-replacement-transactions'),
} = {}) {
  const rootPath = path.resolve(root);
  const expectedStore = String(storeKey || '').trim().toUpperCase();
  const expectedFingerprint = String(workFingerprint || '').trim().toLowerCase();
  if (!expectedStore || !/^[a-f0-9]{64}$/.test(expectedFingerprint) || !rescuePath) return null;
  const expectedRescuePath = path.resolve(rescuePath);
  const relativeRescuePath = path.relative(rootPath, expectedRescuePath);
  if (relativeRescuePath === '..' || relativeRescuePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRescuePath)) {
    fail(`continuation rescue path escapes root: ${expectedRescuePath}`, 'MARKETING_CONTINUATION_SCOPE_INVALID');
  }
  let rescueBytes;
  try {
    rescueBytes = await fs.readFile(expectedRescuePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const expectedRescueHash = crypto.createHash('sha256').update(rescueBytes).digest('hex');
  const expectedTransactionId = crypto.createHash('sha256')
    .update(`${expectedStore}\n${expectedRescueHash}`)
    .digest('hex')
    .slice(0, 24);
  const file = path.join(journalDir, `limited-discount-tx-${expectedStore}-${expectedTransactionId}.json`);
  let journal;
  try {
    journal = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail(`persisted continuation journal is unreadable: ${file}`, 'MARKETING_CONTINUATION_JOURNAL_INVALID');
  }
  const journalRescuePath = path.resolve(rootPath, String(journal?.rescuePath || ''));
  if (String(journal?.storeKey || '').toUpperCase() !== expectedStore
    || String(journal?.transactionId || '') !== expectedTransactionId
    || String(journal?.rescueHash || '').toLowerCase() !== expectedRescueHash
    || String(journal?.runPayloadHash || '').toLowerCase() !== expectedFingerprint
    || journalRescuePath !== expectedRescuePath) {
    fail(`persisted continuation journal does not exactly bind candidate ${expectedStore}:${relativeRescuePath}`,
      'MARKETING_CONTINUATION_SCOPE_MISMATCH');
  }
  if (journal?.mutationsStarted !== true) return null;
  if (journal?.phase === 'completed' && journal?.result?.ok === true) return null;

  if (journal?.createAttempt !== undefined && journal?.createAttempt !== null) {
    const attempt = journal.createAttempt;
    const scope = attempt?.exactScope;
    const targetSkcs = Array.isArray(scope?.targetSkcs)
      ? [...new Set(scope.targetSkcs.map(value => String(value || '').trim()).filter(Boolean))].sort()
      : null;
    const scopeRescuePath = path.resolve(rootPath, String(scope?.rescuePath || ''));
    const scopeRelative = path.relative(rootPath, scopeRescuePath);
    let scopeHash = '';
    try {
      if (scopeRelative === '..' || scopeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(scopeRelative)) throw new Error('scope escapes root');
      scopeHash = crypto.createHash('sha256').update(await fs.readFile(scopeRescuePath)).digest('hex');
    } catch {
      fail(`persisted continuation createAttempt exactScope is unreadable: ${file}`,
        'MARKETING_CONTINUATION_SCOPE_INVALID');
    }
    const operationId = crypto.createHash('sha256').update(JSON.stringify({
      role: attempt?.role,
      workFingerprint: attempt?.workFingerprint,
      exactScope: scope,
    })).digest('hex');
    if (attempt?.schemaVersion !== 1
      || attempt?.operation !== 'limited_discount_create'
      || !['create_only', 'replacement_desired'].includes(attempt?.role)
      || String(attempt?.workFingerprint || '').toLowerCase() !== expectedFingerprint
      || String(attempt?.operationId || '') !== operationId
      || String(scope?.storeKey || '').toUpperCase() !== expectedStore
      || String(scope?.transactionId || '') !== expectedTransactionId
      || !/^[a-f0-9]{64}$/.test(String(scope?.rescueHash || '').toLowerCase())
      || String(scope?.rescueHash || '').toLowerCase() !== scopeHash
      || !targetSkcs?.length
      || JSON.stringify(scope.targetSkcs) !== JSON.stringify(targetSkcs)) {
      fail(`persisted continuation createAttempt does not exactly bind its operation scope: ${file}`,
        'MARKETING_CONTINUATION_SCOPE_MISMATCH');
    }
  }
  return {file, journal, rescueHash: expectedRescueHash, transactionId: expectedTransactionId};
}
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
