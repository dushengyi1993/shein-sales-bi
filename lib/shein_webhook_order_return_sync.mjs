/**
 * Safe, narrow sync primitives for a webhook worker.
 *
 * These functions fetch one identified SHEIN order/return and persist only its
 * OpenAPI header, item rows, and (for orders) payment flag.  They never invoke
 * the date-slice loaders, daily summaries, or reconciliation writers.
 */
import {
  fetchOpenApiOrderDetailsForStore,
} from '../scripts/fetch_shein_openapi_sales.mjs';
import {
  fetchOpenApiReturnOrderDetailsForStore,
} from '../scripts/fetch_shein_openapi_returns.mjs';
import {
  upsertTargetedOpenApiSales,
  readbackTargetedOpenApiSales,
} from '../scripts/load_shein_openapi_sales_warehouse.mjs';
import {
  upsertTargetedOpenApiReturns,
  readbackTargetedOpenApiReturns,
} from '../scripts/load_shein_openapi_returns_warehouse.mjs';

function text(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`Missing ${label}`);
  return result;
}

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || Object.assign(new Error('Webhook worker lease was lost'), {code: 'SHEIN_WEBHOOK_LEASE_LOST'});
}

function dateFrom(values, label) {
  for (const value of values) {
    const matched = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
    if (matched) return matched[1];
  }
  throw new Error(`Missing business date for ${label}; targeted sync refuses to write an unbound date`);
}

/** Fetch and normalize one order artifact.  No database operation occurs. */
export async function fetchWebhookOrderArtifact({storeKey, orderNo, signal, ...options} = {}) {
  const normalizedStore = text(storeKey, 'storeKey').toUpperCase();
  const normalizedOrderNo = text(orderNo, 'orderNo');
  assertNotAborted(signal);
  const artifact = await fetchOpenApiOrderDetailsForStore({storeKey: normalizedStore, orderNos: [normalizedOrderNo], ...options});
  assertNotAborted(signal);
  const row = artifact.orderRows.find((value) => String(value?.orderNo || '') === normalizedOrderNo);
  artifact.start = dateFrom([row?.orderCreateTime, row?.allocateTimeFull, artifact.orders[0]?.orderCreateTime, artifact.orders[0]?.addTime], `${normalizedStore}/${normalizedOrderNo}`);
  artifact.end = artifact.start;
  return artifact;
}

/** Fetch and normalize one return artifact.  No database operation occurs. */
export async function fetchWebhookReturnArtifact({storeKey, returnOrderNo, signal, ...options} = {}) {
  const normalizedStore = text(storeKey, 'storeKey').toUpperCase();
  const normalizedReturnOrderNo = text(returnOrderNo, 'returnOrderNo');
  assertNotAborted(signal);
  const artifact = await fetchOpenApiReturnOrderDetailsForStore({storeKey: normalizedStore, returnOrderNos: [normalizedReturnOrderNo], ...options});
  assertNotAborted(signal);
  const row = artifact.returnOrders.find((value) => String(value?.returnOrderNo || '') === normalizedReturnOrderNo);
  artifact.start = dateFrom([row?.requestReturnTime, row?.addTime], `${normalizedStore}/${normalizedReturnOrderNo}`);
  artifact.end = artifact.start;
  return artifact;
}

/**
 * Fetch, targeted-upsert, then read back one order. `executor` is injectable
 * for deterministic tests; production callers normally omit it.
 */
export async function syncWebhookOrder({storeKey, orderNo, warehouseArgs = {}, executor, skipReadback = false, signal, ...fetchOptions} = {}) {
  const normalizedStore = text(storeKey, 'storeKey').toUpperCase();
  const normalizedOrderNo = text(orderNo, 'orderNo');
  assertNotAborted(signal);
  const artifact = await fetchWebhookOrderArtifact({storeKey: normalizedStore, orderNo: normalizedOrderNo, signal, ...fetchOptions});
  assertNotAborted(signal);
  const mutation = await upsertTargetedOpenApiSales(warehouseArgs, {
    artifact, storeKey: normalizedStore, orderNo: normalizedOrderNo,
  }, executor ? {executor} : undefined);
  assertNotAborted(signal);
  const readback = skipReadback ? null : await readbackTargetedOpenApiSales(warehouseArgs, {
    storeKey: normalizedStore, orderNo: normalizedOrderNo,
  }, mutation.rowCounts, executor ? {executor} : undefined);
  assertNotAborted(signal);
  return {kind: 'order', storeKey: normalizedStore, orderNo: normalizedOrderNo, artifact, mutation, readback};
}

/** Fetch, targeted-upsert, then read back one return order. */
export async function syncWebhookReturn({storeKey, returnOrderNo, warehouseArgs = {}, executor, skipReadback = false, signal, ...fetchOptions} = {}) {
  const normalizedStore = text(storeKey, 'storeKey').toUpperCase();
  const normalizedReturnOrderNo = text(returnOrderNo, 'returnOrderNo');
  assertNotAborted(signal);
  const artifact = await fetchWebhookReturnArtifact({storeKey: normalizedStore, returnOrderNo: normalizedReturnOrderNo, signal, ...fetchOptions});
  assertNotAborted(signal);
  const mutation = await upsertTargetedOpenApiReturns(warehouseArgs, {
    artifact, storeKey: normalizedStore, returnOrderNo: normalizedReturnOrderNo,
  }, executor ? {executor} : undefined);
  assertNotAborted(signal);
  const readback = skipReadback ? null : await readbackTargetedOpenApiReturns(warehouseArgs, {
    storeKey: normalizedStore, returnOrderNo: normalizedReturnOrderNo,
  }, mutation.rowCounts, executor ? {executor} : undefined);
  assertNotAborted(signal);
  return {kind: 'return', storeKey: normalizedStore, returnOrderNo: normalizedReturnOrderNo, artifact, mutation, readback};
}
