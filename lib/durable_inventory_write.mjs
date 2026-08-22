import fs from 'node:fs/promises';
import {computeInventoryOverwriteQuantity, stableInventoryHash} from './inventory_replenishment_policy.mjs';

export function inventoryRecoveryScopeKey({runDate, storeKey, skc, skuCode} = {}) {
  return stableInventoryHash({
    runDate: String(runDate || ''),
    store: String(storeKey || ''),
    skc: String(skc || ''),
    sku: String(skuCode || ''),
    actionType: 'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',
    invType: 'VI',
  });
}

export function recoveredInventoryIntentMismatch(intent, {logicalActionKey, plan, row, approvedTarget, authorizationId}) {
  const requestRow = intent?.request?.body?.updateSkuInventoryQuantityRequests?.[0];
  const expectedOverwrite = computeInventoryOverwriteQuantity(approvedTarget, intent?.before || {});
  const expectedRecoveryScopeKey = inventoryRecoveryScopeKey({runDate: plan.date, storeKey: row.storeKey, skc: row.skc, skuCode: row.skuCode});
  const expectedChangeReason = plan?.executionConstraints?.decreaseOnly
    ? 'Owner-authorized ET low-inventory safety reduction after current-day ET guard'
    : 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard';
  const checks = [
    [intent?.recoveryScopeKey === expectedRecoveryScopeKey, 'recoveryScopeKey'],
    [intent?.logicalActionKey === logicalActionKey, 'logicalActionKey'],
    [intent?.planHash === plan.payloadHash, 'planHash'],
    [intent?.runDate === plan.date, 'runDate'],
    [intent?.storeKey === row.storeKey, 'storeKey'],
    [intent?.skc === row.skc, 'skc'],
    [intent?.skuCode === row.skuCode, 'skuCode'],
    [Number(intent?.targetUsableInventory) === approvedTarget, 'targetUsableInventory'],
    [intent?.policyVersion === plan.policyVersion, 'policyVersion'],
    [intent?.authorizationId === authorizationId, 'authorizationId'],
    [intent?.idempotencyKey === `bi-inv-${logicalActionKey.slice(0, 42)}`, 'idempotencyKey'],
    [intent?.requestPayloadHash === stableInventoryHash(intent?.request), 'requestPayloadHash'],
    [intent?.request?.pathname === '/open-api/stock/change-inventory/v2' && intent?.request?.method === 'POST', 'requestRoute'],
    [requestRow?.idempotencyKey === intent?.idempotencyKey, 'request.idempotencyKey'],
    [requestRow?.skuCode === row.skuCode && requestRow?.invType === 'VI' && requestRow?.changeType === 'OVERWRITE', 'request.identity'],
    [Number(requestRow?.changeQuantity) === expectedOverwrite, 'request.changeQuantity'],
    [requestRow?.changeReason === expectedChangeReason, 'request.changeReason'],
    [intent?.request?.headers?.language === 'en' && Object.keys(intent.request.headers).length === 1, 'request.headers'],
    [intent?.before?.stockRowMissing === true ? Boolean(requestRow?.warehouseCode) : !requestRow?.warehouseCode, 'request.warehouseCode'],
  ];
  return checks.find(([ok]) => !ok)?.[1] || '';
}

export async function appendDurableJournalRecord(journalFile, entry) {
  try {
    const existing = await fs.readFile(journalFile, 'utf8');
    if (existing && !existing.endsWith('\n')) throw new Error('INVENTORY_JOURNAL_TORN_TAIL');
    for (const line of existing.split(/\r?\n/).filter(Boolean)) {
      try { JSON.parse(line); } catch { throw new Error('INVENTORY_JOURNAL_INVALID_LINE'); }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const handle = await fs.open(journalFile, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readInventoryIntentLifecycle(journalFile) {
  const intents = new Map();
  const pending = new Map();
  const terminalOutcomes = new Map();
  let text = '';
  try {
    text = await fs.readFile(journalFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return {intents, pending, terminalOutcomes};
    throw error;
  }
  if (text && !text.endsWith('\n')) throw new Error('INVENTORY_JOURNAL_TORN_TAIL');
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    try {
      const entry = JSON.parse(line);
      if (entry?.kind === 'intent' && entry?.logicalActionKey) {
        const intentId = entry.intentId || `legacy-${index}-${entry.logicalActionKey}`;
        const intent = {...entry, intentId};
        intents.set(intentId, intent);
        pending.set(intentId, intent);
      } else if (entry?.kind === 'write_outcome' && entry?.intentId && ['rejected', 'readback_matched'].includes(entry?.disposition)) {
        pending.delete(entry.intentId);
        terminalOutcomes.set(entry.intentId, entry);
      }
    } catch {
      throw new Error(`INVENTORY_JOURNAL_INVALID_LINE:${index + 1}`);
    }
  }
  return {intents, pending, terminalOutcomes};
}

export async function readPendingInventoryIntents(journalFile) {
  return (await readInventoryIntentLifecycle(journalFile)).pending;
}

export function classifyRecoveredInventoryIntent(intent, currentUsableInventory) {
  if (!intent?.logicalActionKey) throw new Error('durable inventory intent is missing logicalActionKey');
  const target = Number(intent.targetUsableInventory);
  const current = Number(currentUsableInventory);
  if (!Number.isFinite(current) || !Number.isInteger(target)) throw new Error('durable inventory recovery inventory is invalid');
  return current === target ? 'readback_matched' : 'submitted_but_readback_pending';
}

export async function submitDurableInventoryWriteOnce({
  journalFile,
  intent,
  submit,
  readback,
  wait = async () => {},
  maxReadbackAttempts = 10,
} = {}) {
  if (!journalFile || !intent?.intentId || !intent?.logicalActionKey || typeof submit !== 'function' || typeof readback !== 'function') {
    throw new Error('invalid durable inventory submission arguments');
  }
  if (!Number.isInteger(maxReadbackAttempts) || maxReadbackAttempts < 1) throw new Error('invalid maxReadbackAttempts');
  await appendDurableJournalRecord(journalFile, intent);
  let response;
  try {
    response = await submit();
  } catch (error) {
    error.inventoryIntentDurable = true;
    throw error;
  }
  const responseCode = response?.data?.code;
  const hasExplicitCode = responseCode !== undefined && responseCode !== null && String(responseCode) !== '';
  if (hasExplicitCode && (String(responseCode) !== '0' || response?.data?.info?.success === false)) {
    await appendDurableJournalRecord(journalFile, {
      kind: 'write_outcome',
      intentId: intent.intentId,
      logicalActionKey: intent.logicalActionKey,
      disposition: 'rejected',
      recordedAt: new Date().toISOString(),
      code: response?.data?.code,
    });
    return {state: 'rejected', response, after: null, readbackAttempts: 0};
  }
  if (!hasExplicitCode || response?.data?.info?.success !== true) {
    return {state: 'ambiguous_response', response, after: null, readbackAttempts: 0};
  }
  let after = null;
  for (let attempt = 1; attempt <= maxReadbackAttempts; attempt += 1) {
    if (attempt > 1) await wait(attempt);
    try {
      after = await readback(attempt);
    } catch (error) {
      error.inventoryIntentDurable = true;
      throw error;
    }
    if (Number(after?.totalUsableInventory) === Number(intent.targetUsableInventory)) {
      await appendDurableJournalRecord(journalFile, {
        kind: 'write_outcome',
        intentId: intent.intentId,
        logicalActionKey: intent.logicalActionKey,
        disposition: 'readback_matched',
        recordedAt: new Date().toISOString(),
      });
      return {state: 'readback_matched', response, after, readbackAttempts: attempt};
    }
  }
  return {state: 'submitted_but_readback_pending', response, after, readbackAttempts: maxReadbackAttempts};
}
