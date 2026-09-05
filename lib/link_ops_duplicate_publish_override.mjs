import {normalizeSheinSkc} from './shein_product_identifiers.mjs';

export const ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT = 'ALLOW_ADDITIONAL_SAME_CODE_LINK';

function safeString(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeStoreKey(value) {
  return safeString(value, 40).toUpperCase();
}

function normalizeSkcList(value) {
  const rows = Array.isArray(value) ? value : [value];
  return [...new Set(rows
    .map(item => normalizeSheinSkc(safeString(item, 120)))
    .filter(Boolean))];
}

export function normalizeAdditionalDuplicatePublishOverrideInput(value = {}) {
  return {
    kind: safeString(value.kind || 'additional_same_supplier_code_link', 80),
    store: normalizeStoreKey(value.store || value.storeKey),
    existingSkcs: normalizeSkcList(value.existingSkcs || value.existingSkc || value.skc),
    reason: safeString(value.reason || value.note, 1000),
    confirmation: safeString(value.confirmation || value.confirm, 120),
    requestId: safeString(value.requestId || value.idempotencyKey || value.requestKey, 120),
    businessIntent: safeString(value.businessIntent || value.intent || 'republish_new_link', 80),
  };
}

export function evaluateAdditionalDuplicatePublishOverride(task, targetStore, blockingMatches = []) {
  const override = task?.duplicatePublishOverride;
  if (!override || typeof override !== 'object') {
    return {allowed: false, status: 'not_requested', store: normalizeStoreKey(targetStore), existingSkcs: []};
  }
  const normalized = normalizeAdditionalDuplicatePublishOverrideInput(override);
  const approvedBy = safeString(
    typeof override?.approvedBy === 'string'
      ? override.approvedBy
      : override?.approvedBy?.username || override?.approvedBy?.displayName,
    120,
  );
  const approvedAt = safeString(override?.approvedAt, 80);
  const targetStoreKey = normalizeStoreKey(targetStore);
  const storeMatches = normalized.store === targetStoreKey;
  const liveSkcs = [...new Set((Array.isArray(blockingMatches) ? blockingMatches : [])
    .map(row => normalizeSheinSkc(safeString(row?.skcName || row?.skc, 120)))
    .filter(Boolean))].sort();
  const expectedSkcs = normalized.existingSkcs.slice().sort();

  // A2: User intent to create a new/additional link is a business fact.
  // Existing links are informative, not blocking approval material.
  // Other tasks adding the same link or set drifting does NOT revoke this authorization.
  // English confirmation string and >=8 char reason are no longer mandatory.
  const allowed = task?.allowDuplicateNewPublish === true
    && storeMatches
    && approvedBy.length > 0
    && Number.isFinite(Date.parse(approvedAt));

  const isExactSetMatch = liveSkcs.length > 0 && JSON.stringify(liveSkcs) === JSON.stringify(expectedSkcs);
  let status = 'authorization_mismatch';
  if (!storeMatches) {
    status = 'store_mismatch';
  } else if (allowed) {
    status = isExactSetMatch ? 'authorized_exact_live_duplicate_set' : 'authorized_additional_link';
  }

  return {
    allowed,
    status,
    store: normalized.store,
    existingSkcs: expectedSkcs,
    liveBlockingSkcs: liveSkcs,
    reason: normalized.reason,
    approvedAt,
    approvedBy,
    requestId: normalized.requestId,
    businessIntent: normalized.businessIntent,
  };
}
