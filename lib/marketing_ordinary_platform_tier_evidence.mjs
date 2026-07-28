import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_REGISTRY_PATH = path.join('config', 'marketing_ordinary_platform_tier_overrides.json');

function normStore(value) {
  return String(value || '').trim().toUpperCase();
}

function normSkc(value) {
  return String(value || '').trim().toLowerCase();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseShanghaiMs(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text.replace(' ', 'T')}+08:00`;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function entryKey(storeKey, skc) {
  return `${normStore(storeKey)}::${normSkc(skc)}`;
}

export async function loadOrdinaryPlatformTierRegistry({
  root = process.cwd(),
  registryPath = DEFAULT_REGISTRY_PATH,
} = {}) {
  const file = path.resolve(root, registryPath);
  try {
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      ...doc,
      sourcePath: path.relative(path.resolve(root), file),
      entries: Array.isArray(doc?.entries) ? doc.entries : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {schemaVersion: 1, sourcePath: path.relative(path.resolve(root), file), entries: []};
    }
    throw error;
  }
}

export function buildOrdinaryPlatformTierEvidenceIndex({
  registry,
  ordinaryEvidenceByStore,
} = {}) {
  const byKey = new Map();
  const add = raw => {
    const storeKey = normStore(raw?.storeKey);
    const skc = normSkc(raw?.skc);
    const platformTierPrice = numberOrNull(raw?.platformTierPrice ?? raw?.ordinaryMarketingPrice);
    if (!storeKey || !skc || !(platformTierPrice > 0)) return;
    const item = {
      storeKey,
      skc,
      activityId: Number(raw?.activityId || 0) || null,
      approvedTargetPrice: numberOrNull(raw?.approvedTargetPrice),
      platformTierPrice,
      validFrom: raw?.validFrom || raw?.eventStart || '',
      validTo: raw?.validTo || raw?.eventEnd || '',
      validFromMs: parseShanghaiMs(raw?.validFrom || raw?.eventStart),
      validToMs: parseShanghaiMs(raw?.validTo || raw?.eventEnd),
      status: raw?.status || 'active',
      sourceType: raw?.sourceType || '',
      sourcePath: raw?.sourcePath || raw?.fillSource || '',
      evidenceTrust: raw?.evidenceTrust || '',
      platformAdjustmentStatus: raw?.platformAdjustmentStatus || '',
      priority: Number(raw?.priority || 0),
    };
    const key = entryKey(storeKey, skc);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(item);
  };

  for (const entry of Array.isArray(registry?.entries) ? registry.entries : []) {
    add({
      ...entry,
      sourceType: 'persistent_platform_tier_registry',
      sourcePath: registry?.sourcePath || '',
      priority: 100,
    });
  }

  for (const storeEvidence of ordinaryEvidenceByStore?.values?.() || []) {
    for (const row of Array.isArray(storeEvidence?.rows) ? storeEvidence.rows : []) {
      const trusted = ['submitted', 'batch_submit_enabled_result_ok'].includes(row?.evidenceTrust);
      const platformAdjusted = row?.belowApprovedTarget === true
        || row?.platformAdjustmentStatus === 'below_target_due_to_platform_forced_discount';
      if (!trusted || !platformAdjusted) continue;
      add({
        ...row,
        platformTierPrice: row.ordinaryMarketingPrice,
        validFrom: row.eventStart,
        validTo: row.eventEnd,
        sourceType: 'submitted_deadline_fill_platform_tier',
        priority: row.evidenceTrust === 'submitted' ? 90 : 80,
      });
    }
  }

  for (const rows of byKey.values()) {
    rows.sort((a, b) => b.priority - a.priority
      || Number(b.validFromMs || 0) - Number(a.validFromMs || 0));
  }
  return byKey;
}

export function findActiveOrdinaryPlatformTier(index, {
  storeKey,
  skc,
  activityId,
  at,
} = {}) {
  const rows = index?.get?.(entryKey(storeKey, skc)) || [];
  const atMs = parseShanghaiMs(at) ?? (at instanceof Date ? at.getTime() : Date.now());
  const active = rows.filter(row => {
    if (String(row.status || 'active').toLowerCase() !== 'active') return false;
    if (row.validFromMs !== null && atMs < row.validFromMs) return false;
    if (row.validToMs !== null && atMs > row.validToMs) return false;
    return true;
  });
  if (activityId) {
    const exactActivity = active.find(row => Number(row.activityId) === Number(activityId));
    if (exactActivity) return exactActivity;
    // Evidence tied to another activity must never leak into the requested
    // activity merely because the store, SKC and time windows overlap.
    return active.find(row => !row.activityId) || null;
  }
  return active[0] || null;
}
