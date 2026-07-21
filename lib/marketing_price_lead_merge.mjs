function present(value) {
  if (value == null) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return String(value).trim() !== '';
}

function sourceDescriptor(value = {}) {
  const file = String(value.marketing_price_source_file || '').trim();
  if (!file) return null;
  return {
    type: String(value.marketing_price_evidence_type || '').trim(),
    file,
    at: String(value.marketing_price_source_at || '').trim(),
  };
}

function sourceKey(value = {}) {
  return `${value.type || ''}\u0000${value.file || ''}\u0000${value.at || ''}`;
}

export function mergeRankedMarketingPriceLead(previous, incoming, options = {}) {
  const next = Object.fromEntries(Object.entries(incoming || {}).filter(([, value]) => present(value)));
  if (!previous) {
    const source = sourceDescriptor(next);
    return {
      ...next,
      marketing_price_evidence_count: Math.max(1, Number(next.marketing_price_evidence_count || 1)),
      marketing_price_sources: source ? [source] : [],
    };
  }

  const current = Object.fromEntries(Object.entries(previous).filter(([, value]) => present(value)));
  const currentRank = Number(current.marketing_price_source_rank || 0);
  const nextRank = Number(next.marketing_price_source_rank || 0);
  const currentAt = String(current.marketing_price_source_at || '');
  const nextAt = String(next.marketing_price_source_at || '');
  const preferNext = nextRank > currentRank || (nextRank === currentRank && nextAt >= currentAt);
  const primary = preferNext ? next : current;
  const secondary = preferNext ? current : next;
  const merged = {...secondary, ...primary};

  const notes = [current.marketing_price_note, next.marketing_price_note]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  if (notes.length) merged.marketing_price_note = [...new Set(notes)].join('；');

  const sources = [
    ...(Array.isArray(current.marketing_price_sources) ? current.marketing_price_sources : []),
    ...(Array.isArray(next.marketing_price_sources) ? next.marketing_price_sources : []),
    sourceDescriptor(current),
    sourceDescriptor(next),
  ].filter(Boolean);
  const uniqueSources = [];
  const seen = new Set();
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueSources.push(source);
  }
  merged.marketing_price_sources = uniqueSources.slice(-Math.max(1, Number(options.sourceLimit || 8)));
  merged.marketing_price_evidence_count = Math.max(1, Number(current.marketing_price_evidence_count || 1))
    + Math.max(1, Number(next.marketing_price_evidence_count || 1));
  return merged;
}
