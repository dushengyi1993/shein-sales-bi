import {reconcileProductTask} from './shein_webhook_handlers.mjs';

function positiveInteger(value, fallback, {min = 1, max = 60_000} = {}) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Privileged bridge between the public webhook receipt store and mutable
 * LinkOps tasks. The webhook receiver remains least-privileged; this worker
 * runs inside the authenticated portal process and only consumes verified,
 * normalized, already-succeeded product lifecycle receipts.
 */
export function createSheinWebhookTaskReconciler({
  webhookRepository,
  linkOpsRepository,
  pollMs = 5_000,
  batchSize = 50,
  onEvent = null,
} = {}) {
  if (!webhookRepository?.listTaskReconciliationReceipts
    || !webhookRepository?.getTaskReconciliationReceipt
    || !webhookRepository?.markTaskReconciliation) {
    throw new TypeError('A task-reconciliation-capable webhook repository is required');
  }
  if (!linkOpsRepository?.getTaskStore || !linkOpsRepository?.updateTask) {
    throw new TypeError('A mutable LinkOps repository is required');
  }

  const interval = positiveInteger(pollMs, 5_000, {min: 1_000, max: 60_000});
  const limit = positiveInteger(batchSize, 50, {min: 1, max: 500});
  let timer = null;
  let stopped = true;
  let running = null;

  const emit = event => {
    try { Promise.resolve(onEvent?.(event)).catch(() => {}); } catch {}
  };

  const reconcileOne = async (receipt, taskStore = null) => {
    if (!receipt) return null;
    const outcome = await reconcileProductTask({
      receipt: {
        ...receipt,
        normalized: receipt.normalized || {},
        idempotencyKey: receipt.idempotencyKey || receipt.id,
      },
      linkOpsRepository,
      taskStore,
    });
    const actionState = String(outcome?.actionState || '');
    if (!['task_readback_attached', 'task_unmatched', 'task_match_ambiguous'].includes(actionState)) {
      throw new Error(`Unexpected webhook task reconciliation state: ${actionState || '(empty)'}`);
    }
    await webhookRepository.markTaskReconciliation(receipt.id, {
      actionState,
      taskId: outcome?.taskId || '',
    });
    emit({event: 'receipt-reconciled', receiptId: receipt.id, actionState, taskId: outcome?.taskId || ''});
    return outcome;
  };

  const runBatch = async ({receiptId = null} = {}) => {
    if (running) return running;
    running = (async () => {
      const receipts = receiptId
        ? [await webhookRepository.getTaskReconciliationReceipt(receiptId)].filter(Boolean)
        : await webhookRepository.listTaskReconciliationReceipts({limit});
      if (!receipts.length) return {processed: 0};
      const taskStore = await linkOpsRepository.getTaskStore({limit: 10_000});
      let processed = 0;
      let failed = 0;
      for (const receipt of receipts) {
        try {
          await reconcileOne(receipt, taskStore);
          processed += 1;
        } catch (error) {
          failed += 1;
          emit({event: 'receipt-failed', receiptId: receipt?.id || '', error: String(error?.message || error)});
        }
      }
      return {processed, failed};
    })().finally(() => { running = null; });
    return running;
  };

  return Object.freeze({
    runBatch,
    reconcileReceipt: receiptId => runBatch({receiptId}),
    async start() {
      if (!stopped) return;
      stopped = false;
      await runBatch();
      timer = setInterval(() => { if (!stopped) void runBatch(); }, interval);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  });
}
