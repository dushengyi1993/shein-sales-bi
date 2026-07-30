function compact(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  return [...new Set((values || []).map(compact).filter(Boolean))];
}

function instant(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

export function selectOpenapiProductDetailSpus({
  spuNames = [],
  budget = 0,
  priorPayload = null,
  prioritySpus = [],
  dateKey = '',
} = {}) {
  const names = unique(spuNames).sort();
  const limit = Math.max(0, Number.isFinite(Number(budget)) ? Math.trunc(Number(budget)) : 0);
  if (!limit || limit >= names.length) return names;

  const allowed = new Set(names);
  const explicitPriority = unique(prioritySpus).filter(spu => allowed.has(spu));
  const explicitlyPrioritized = new Set(explicitPriority);
  const priorFailures = unique((priorPayload?.detailResults || [])
    .filter(row => row?.ok !== true)
    .map(row => row?.spuName))
    .filter(spu => allowed.has(spu) && !explicitlyPrioritized.has(spu));
  const failed = new Set(priorFailures);
  const remaining = names.filter(spu => !failed.has(spu) && !explicitlyPrioritized.has(spu));
  const dayNumber = Math.floor((instant(dateKey) ?? Date.now()) / 86_400_000);
  const start = remaining.length ? ((dayNumber * limit) % remaining.length) : 0;
  const rotated = remaining.length
    ? [...remaining.slice(start), ...remaining.slice(0, start)]
    : [];
  return [...explicitPriority, ...priorFailures, ...rotated].slice(0, limit);
}

export function collectOpenapiProductDetailFallbacks({
  priorPayloads = [],
  currentDetailResults = [],
  allowedSpus = [],
} = {}) {
  const allowed = new Set(unique(allowedSpus));
  const current = new Set((currentDetailResults || [])
    .filter(row => row?.ok === true && row?.info)
    .map(row => compact(row?.spuName || row?.info?.spuName))
    .filter(Boolean));
  const selected = new Map();

  for (const payload of priorPayloads || []) {
    const payloadFetchedAt = compact(payload?.fetchedAt || payload?.generatedAt);
    for (const row of [...(payload?.detailResults || []), ...(payload?.detailFallbackResults || [])]) {
      if (row?.ok !== true || !row?.info) continue;
      const spuName = compact(row?.spuName || row?.info?.spuName);
      if (!spuName || !allowed.has(spuName) || current.has(spuName) || selected.has(spuName)) continue;
      selected.set(spuName, {
        spuName,
        ok: true,
        info: row.info,
        detailFetchedAt: compact(row?.detailFetchedAt || row?.fetchedAt || payloadFetchedAt),
        source: 'prior_cache',
      });
    }
  }
  return [...selected.values()];
}
