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
    kind: 'additional_same_supplier_code_link',
    store: normalizeStoreKey(value.store || value.storeKey),
    existingSkcs: normalizeSkcList(value.existingSkcs || value.existingSkc || value.skc),
    reason: safeString(value.reason || value.note, 1000),
    confirmation: safeString(value.confirmation || value.confirm, 120),
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
  const liveSkcs = [...new Set((Array.isArray(blockingMatches) ? blockingMatches : [])
    .map(row => normalizeSheinSkc(safeString(row?.skcName || row?.skc, 120)))
    .filter(Boolean))].sort();
  const expectedSkcs = normalized.existingSkcs.slice().sort();
  const allowed = task?.allowDuplicateNewPublish === true
    && normalized.kind === 'additional_same_supplier_code_link'
    && normalized.store === normalizeStoreKey(targetStore)
    && normalized.confirmation === ADDITIONAL_DUPLICATE_PUBLISH_CONFIRM_TEXT
    && normalized.reason.length >= 8
    && approvedBy.length > 0
    && Number.isFinite(Date.parse(approvedAt))
    && liveSkcs.length > 0
    && JSON.stringify(liveSkcs) === JSON.stringify(expectedSkcs);
  return {
    allowed,
    status: allowed ? 'authorized_exact_live_duplicate_set' : 'authorization_mismatch',
    store: normalized.store,
    existingSkcs: expectedSkcs,
    liveBlockingSkcs: liveSkcs,
    reason: normalized.reason,
    approvedAt,
    approvedBy,
  };
}
