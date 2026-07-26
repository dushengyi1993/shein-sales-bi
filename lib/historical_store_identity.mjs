function normalizedStoreKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizedDate(value) {
  const match = String(value || '').trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function storeConfigMap(stores = []) {
  return new Map((stores || []).map(store => {
    const key = normalizedStoreKey(store?.storeKey ?? store?.store_key);
    return [key, {
      storeKey: key,
      groupKey: String(store?.groupKey ?? store?.group_key ?? '').trim(),
      shopName: String(store?.shopName ?? store?.shop_name ?? '').trim(),
    }];
  }).filter(([key]) => key));
}

export function validateHistoricalStoreIdentityConfig(config, stores = []) {
  const corrections = Array.isArray(config?.corrections) ? config.corrections : [];
  const knownStores = storeConfigMap(stores);
  const seenIds = new Set();
  const normalized = corrections.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    const sourceStoreKey = normalizedStoreKey(entry?.sourceStoreKey);
    const effectiveStoreKey = normalizedStoreKey(entry?.effectiveStoreKey);
    const startDate = normalizedDate(entry?.startDate);
    const endDate = normalizedDate(entry?.endDate);
    if (!id || seenIds.has(id)) throw new Error(`Invalid or duplicate historical store correction id at index ${index}`);
    seenIds.add(id);
    if (!sourceStoreKey || !effectiveStoreKey || sourceStoreKey === effectiveStoreKey) {
      throw new Error(`Invalid historical store correction stores for ${id}`);
    }
    if (!startDate || !endDate || startDate > endDate) {
      throw new Error(`Invalid historical store correction date range for ${id}`);
    }
    if (knownStores.size && (!knownStores.has(sourceStoreKey) || !knownStores.has(effectiveStoreKey))) {
      throw new Error(`Unknown store in historical store correction ${id}`);
    }
    return {
      ...entry,
      id,
      sourceStoreKey,
      effectiveStoreKey,
      startDate,
      endDate,
      expectedItemRows: Number(entry?.expectedItemRows || 0),
    };
  });
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i];
      const b = normalized[j];
      if (a.sourceStoreKey !== b.sourceStoreKey) continue;
      const overlaps = a.startDate <= b.endDate && b.startDate <= a.endDate;
      if (overlaps) throw new Error(`Overlapping historical store corrections: ${a.id} / ${b.id}`);
    }
  }
  return normalized;
}

export function resolveHistoricalStoreIdentity({
  sourceStoreKey,
  date,
  config,
  stores = [],
}) {
  const source = normalizedStoreKey(sourceStoreKey);
  const targetDate = normalizedDate(date);
  const corrections = validateHistoricalStoreIdentityConfig(config, stores);
  const matches = corrections.filter(entry => (
    entry.sourceStoreKey === source
    && targetDate >= entry.startDate
    && targetDate <= entry.endDate
  ));
  if (matches.length > 1) throw new Error(`Ambiguous historical store identity for ${source} ${targetDate}`);
  const correction = matches[0] || null;
  const effectiveStoreKey = correction?.effectiveStoreKey || source;
  const effectiveStore = storeConfigMap(stores).get(effectiveStoreKey) || {
    storeKey: effectiveStoreKey,
    groupKey: '',
    shopName: '',
  };
  return {
    corrected: Boolean(correction),
    incidentId: correction ? String(config?.incidentId || correction.id) : '',
    correctionId: correction?.id || '',
    sourceStoreKey: source,
    effectiveStoreKey,
    groupKey: effectiveStore.groupKey,
    shopName: effectiveStore.shopName,
    date: targetDate,
    startDate: correction?.startDate || '',
    endDate: correction?.endDate || '',
  };
}

export function storeIdentityCorrectionEvidence(identity) {
  if (!identity?.corrected) return null;
  return {
    incidentId: identity.incidentId,
    correctionId: identity.correctionId,
    sourceStoreKey: identity.sourceStoreKey,
    effectiveStoreKey: identity.effectiveStoreKey,
    date: identity.date,
    range: `${identity.startDate}..${identity.endDate}`,
  };
}
