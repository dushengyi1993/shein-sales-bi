import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function normalizedAbsolute(file) {
  return path.resolve(file).replace(/[\\/]+$/, '').toLowerCase();
}

function normalizedRelative(root, file) {
  return path.relative(root, file).replaceAll(path.sep, '/');
}

function assertInside(parent, child, label) {
  const relative = path.relative(parent, child);
  if (!relative || relative === '.') return;
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the expected directory: ${child}`);
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function sha256File(file) {
  return hashText(await fs.readFile(file));
}

export async function loadExactHighClickSpecialPlan({root, planPath, guardPath, date}) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlanPath = path.resolve(planPath);
  const resolvedGuardPath = path.resolve(guardPath);
  assertInside(resolvedRoot, resolvedPlanPath, 'high-click special plan');
  assertInside(resolvedRoot, resolvedGuardPath, 'guard report');

  const planText = await fs.readFile(resolvedPlanPath, 'utf8');
  const plan = JSON.parse(planText);
  const guardText = await fs.readFile(resolvedGuardPath, 'utf8');
  if (String(plan.reportDate || '') !== String(date)) {
    throw new Error(`High-click special plan reportDate mismatch: expected=${date} actual=${plan.reportDate || 'missing'}`);
  }
  const guardRelative = normalizedRelative(resolvedRoot, resolvedGuardPath);
  const planGuardPath = path.resolve(resolvedRoot, String(plan.sourceGuard || ''));
  if (!plan.sourceGuard || normalizedAbsolute(planGuardPath) !== normalizedAbsolute(resolvedGuardPath)) {
    throw new Error(`High-click special plan sourceGuard mismatch: expected=${guardRelative} actual=${plan.sourceGuard || 'missing'}`);
  }
  const guardHash = hashText(guardText);
  if (String(plan.sourceGuardHash || '') !== guardHash) {
    throw new Error(`High-click special plan guard hash mismatch: expected=${guardHash} actual=${plan.sourceGuardHash || 'missing'}`);
  }
  const rows = Array.isArray(plan.rows) ? plan.rows : [];
  if (Number(plan.actionCount || 0) !== rows.length) {
    throw new Error(`High-click special plan count mismatch: actionCount=${plan.actionCount || 0} rows=${rows.length}`);
  }
  const seen = new Set();
  const entries = rows.map(row => {
    const storeKey = String(row?.storeKey || '').trim().toUpperCase();
    const skc = String(row?.skc || '').trim();
    const key = `${storeKey}::${skc}`;
    if (!storeKey || !skc) throw new Error('High-click special plan row is missing storeKey or skc');
    if (!(Number(row?.specialPrice) > 0)) throw new Error(`High-click special plan row has invalid specialPrice: ${key}`);
    if (!Number.isInteger(Number(row?.activityStock)) || Number(row.activityStock) <= 0) {
      throw new Error(`High-click special plan row has invalid activityStock: ${key}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate high-click special plan store+SKC key: ${key}`);
    seen.add(key);
    return {...row, storeKey, skc, key};
  });
  const planHash = hashText(planText);
  const workFingerprint = hashText(JSON.stringify({
    planHash,
    guard: guardRelative,
    guardHash,
    rows: entries.map(entry => [
      entry.key,
      entry.specialPrice,
      entry.activityStock,
      entry.validFrom,
      entry.validTo,
    ]),
  }));
  return {
    plan,
    planPath: resolvedPlanPath,
    planRelativePath: normalizedRelative(resolvedRoot, resolvedPlanPath),
    planHash,
    workFingerprint,
    entries,
  };
}

export async function loadExactManualRepairPlan({root, planPath, guardPath, date}) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlanPath = path.resolve(planPath);
  const resolvedPlanDir = path.dirname(resolvedPlanPath);
  const resolvedGuardPath = path.resolve(guardPath);
  assertInside(resolvedRoot, resolvedPlanPath, 'manual repair plan');
  assertInside(resolvedRoot, resolvedGuardPath, 'guard report');

  const planText = await fs.readFile(resolvedPlanPath, 'utf8');
  const plan = JSON.parse(planText);
  if (String(plan.reportDate || '') !== String(date)) {
    throw new Error(`Manual repair plan reportDate mismatch: expected=${date} actual=${plan.reportDate || 'missing'}`);
  }
  const guardRelative = normalizedRelative(resolvedRoot, resolvedGuardPath);
  const planGuardPath = path.resolve(resolvedRoot, String(plan.sourceGuard || ''));
  if (!plan.sourceGuard || normalizedAbsolute(planGuardPath) !== normalizedAbsolute(resolvedGuardPath)) {
    throw new Error(`Manual repair plan sourceGuard mismatch: expected=${guardRelative} actual=${plan.sourceGuard || 'missing'}`);
  }

  const rawEntries = Array.isArray(plan.rescueFiles) ? plan.rescueFiles : [];
  if (Number(plan.restoreCount || 0) !== rawEntries.length) {
    throw new Error(`Manual repair plan count mismatch: restoreCount=${plan.restoreCount || 0} rescueFiles=${rawEntries.length}`);
  }
  const seenPaths = new Set();
  const seenKeys = new Set();
  const entries = [];
  for (const rawEntry of rawEntries) {
    const storeKey = String(rawEntry?.storeKey || '').trim().toUpperCase();
    const skc = String(rawEntry?.skc || '').trim();
    if (!storeKey || !skc) throw new Error('Manual repair plan entry is missing storeKey or skc');
    const rescuePath = path.resolve(resolvedRoot, String(rawEntry?.path || ''));
    assertInside(resolvedPlanDir, rescuePath, 'manual repair file');
    if (path.dirname(rescuePath) !== resolvedPlanDir) {
      throw new Error(`Manual repair file must be a direct child of its plan directory: ${rescuePath}`);
    }
    if (!new RegExp(`^manual-limited-restore-${storeKey}-.*\\.json$`, 'i').test(path.basename(rescuePath))) {
      throw new Error(`Unexpected manual repair filename for ${storeKey}: ${path.basename(rescuePath)}`);
    }
    const pathKey = normalizedAbsolute(rescuePath);
    if (seenPaths.has(pathKey)) throw new Error(`Duplicate manual repair path in plan: ${rawEntry.path}`);
    seenPaths.add(pathKey);
    const workKey = `${storeKey}::${skc}`;
    if (seenKeys.has(workKey)) throw new Error(`Duplicate manual repair store+SKC key in plan: ${workKey}`);
    seenKeys.add(workKey);

    const rescueText = await fs.readFile(rescuePath, 'utf8');
    const rescue = JSON.parse(rescueText);
    const rows = Array.isArray(rescue.rows) ? rescue.rows : [];
    if (String(rescue.storeKey || '').trim().toUpperCase() !== storeKey
      || String(rescue.sourceGuard || '') !== String(plan.sourceGuard || '')
      || String(rescue.purpose || '') !== 'manual_special_limited_discount_registry_restore'
      || rows.length !== 1
      || String(rows[0]?.storeKey || '').trim().toUpperCase() !== storeKey
      || String(rows[0]?.skc || '').trim() !== skc) {
      throw new Error(`Manual repair file does not match its exact plan entry: ${rawEntry.path}`);
    }
    entries.push({
      ...rawEntry,
      storeKey,
      skc,
      path: rescuePath,
      relativePath: normalizedRelative(resolvedRoot, rescuePath),
      contentHash: hashText(rescueText),
      rescue,
    });
  }

  const planHash = hashText(planText);
  const workFingerprint = hashText(JSON.stringify({
    planHash,
    guard: guardRelative,
    files: entries.map(entry => [entry.relativePath, entry.contentHash]),
  }));
  return {
    plan,
    planPath: resolvedPlanPath,
    planRelativePath: normalizedRelative(resolvedRoot, resolvedPlanPath),
    planHash,
    workFingerprint,
    entries,
  };
}

export async function loadExactDriftRepairManifest({root, planDir, guardPath, date}) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlanDir = path.resolve(planDir);
  const resolvedGuardPath = path.resolve(guardPath);
  assertInside(resolvedRoot, resolvedPlanDir, 'drift plan directory');
  assertInside(resolvedRoot, resolvedGuardPath, 'guard report');

  const manifestPath = path.join(resolvedPlanDir, `limited-discount-target-drift-rescue-plan-${date}.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (String(manifest.reportDate || '') !== String(date)) {
    throw new Error(`Drift manifest reportDate mismatch: expected=${date} actual=${manifest.reportDate || 'missing'}`);
  }

  const manifestGuardPath = path.resolve(resolvedRoot, String(manifest.sourceGuard || ''));
  if (normalizedAbsolute(manifestGuardPath) !== normalizedAbsolute(resolvedGuardPath)) {
    throw new Error(`Drift manifest sourceGuard mismatch: expected=${normalizedRelative(resolvedRoot, resolvedGuardPath)} actual=${manifest.sourceGuard || 'missing'}`);
  }

  const rawEntries = Array.isArray(manifest.rescueFiles) ? manifest.rescueFiles : [];
  const seenPaths = new Set();
  const entries = [];
  for (const rawEntry of rawEntries) {
    const storeKey = String(rawEntry?.storeKey || '').trim().toUpperCase();
    if (!storeKey) throw new Error('Drift manifest rescue entry is missing storeKey');
    const rescuePath = path.resolve(resolvedRoot, String(rawEntry?.path || ''));
    assertInside(resolvedPlanDir, rescuePath, 'drift rescue file');
    if (path.dirname(rescuePath) !== resolvedPlanDir) {
      throw new Error(`Drift rescue file must be a direct child of its plan directory: ${rescuePath}`);
    }
    if (!new RegExp(`^limited-drift-rescue-${storeKey}-.*-${date}\\.json$`, 'i').test(path.basename(rescuePath))) {
      throw new Error(`Unexpected drift rescue filename for ${storeKey}: ${path.basename(rescuePath)}`);
    }
    const pathKey = normalizedAbsolute(rescuePath);
    if (seenPaths.has(pathKey)) throw new Error(`Duplicate drift rescue path in manifest: ${rawEntry.path}`);
    seenPaths.add(pathKey);

    const rescueText = await fs.readFile(rescuePath, 'utf8');
    const rescue = JSON.parse(rescueText);
    if (String(rescue.storeKey || '').trim().toUpperCase() !== storeKey) {
      throw new Error(`Drift rescue store mismatch for ${rawEntry.path}`);
    }
    if (String(rescue.sourceGuard || '') !== String(manifest.sourceGuard || '')) {
      throw new Error(`Drift rescue sourceGuard mismatch for ${rawEntry.path}`);
    }
    if (String(rescue.purpose || '') !== `limited_discount_target_price_drift_rescue_${date}`) {
      throw new Error(`Drift rescue purpose mismatch for ${rawEntry.path}`);
    }
    const rows = Array.isArray(rescue.rows) ? rescue.rows : [];
    if (!rows.length) throw new Error(`Drift rescue file has no rows: ${rawEntry.path}`);
    if (Number(rawEntry.count) !== rows.length) {
      throw new Error(`Drift rescue count mismatch for ${rawEntry.path}: manifest=${rawEntry.count} actual=${rows.length}`);
    }
    const wrongStoreRow = rows.find(row => String(row?.storeKey || '').trim().toUpperCase() !== storeKey);
    if (wrongStoreRow) throw new Error(`Drift rescue contains a row for another store: ${rawEntry.path}`);
    entries.push({
      ...rawEntry,
      storeKey,
      path: rescuePath,
      relativePath: normalizedRelative(resolvedRoot, rescuePath),
      contentHash: hashText(rescueText),
      rescue,
    });
  }

  const manifestHash = await sha256File(manifestPath);
  const workFingerprint = hashText(JSON.stringify({
    manifestHash,
    guard: normalizedRelative(resolvedRoot, resolvedGuardPath),
    files: entries.map(entry => [entry.relativePath, entry.contentHash]),
  }));
  return {
    manifest,
    manifestPath,
    manifestRelativePath: normalizedRelative(resolvedRoot, manifestPath),
    manifestHash,
    workFingerprint,
    entries,
  };
}

export async function loadExactFallbackRepairPlan({root, planPath, guardPath, date}) {
  const resolvedRoot = path.resolve(root);
  const resolvedPlanPath = path.resolve(planPath);
  const resolvedGuardPath = path.resolve(guardPath);
  assertInside(resolvedRoot, resolvedPlanPath, 'fallback plan');
  assertInside(resolvedRoot, resolvedGuardPath, 'guard report');

  const planText = await fs.readFile(resolvedPlanPath, 'utf8');
  const plan = JSON.parse(planText);
  const guard = JSON.parse(await fs.readFile(resolvedGuardPath, 'utf8'));
  if (String(plan.reportDate || '') !== String(date)) {
    throw new Error(`Fallback plan reportDate mismatch: expected=${date} actual=${plan.reportDate || 'missing'}`);
  }
  const guardRelative = normalizedRelative(resolvedRoot, resolvedGuardPath);
  const planGuardPath = path.resolve(resolvedRoot, String(plan.sourceGuard || ''));
  if (!plan.sourceGuard || normalizedAbsolute(planGuardPath) !== normalizedAbsolute(resolvedGuardPath)) {
    throw new Error(`Fallback plan sourceGuard mismatch: expected=${guardRelative} actual=${plan.sourceGuard || 'missing'}`);
  }
  const guardScan = String(guard?.limitedDiscountTargetPriceDrift?.source || '');
  if (!plan.sourceCurrentMarketingLiveScan || String(plan.sourceCurrentMarketingLiveScan) !== guardScan) {
    throw new Error(`Fallback plan live-scan mismatch: guard=${guardScan || 'missing'} plan=${plan.sourceCurrentMarketingLiveScan || 'missing'}`);
  }
  const guardPriceOverrides = String(guard?.targetPlanSelection?.priceOverrides || '');
  if (!plan.sourcePriceOverrides || String(plan.sourcePriceOverrides) !== guardPriceOverrides) {
    throw new Error(`Fallback plan price-overrides mismatch: guard=${guardPriceOverrides || 'missing'} plan=${plan.sourcePriceOverrides || 'missing'}`);
  }

  const rawEntries = Array.isArray(plan.rescueFiles) ? plan.rescueFiles : [];
  const seenPaths = new Set();
  const entries = [];
  for (const rawEntry of rawEntries) {
    const storeKey = String(rawEntry?.storeKey || '').trim().toUpperCase();
    if (!storeKey) throw new Error('Fallback rescue entry is missing storeKey');
    const rescuePath = path.resolve(resolvedRoot, String(rawEntry?.path || ''));
    assertInside(resolvedRoot, rescuePath, 'fallback rescue file');
    const pathKey = normalizedAbsolute(rescuePath);
    if (seenPaths.has(pathKey)) throw new Error(`Duplicate fallback rescue path in plan: ${rawEntry.path}`);
    seenPaths.add(pathKey);
    const rescueText = await fs.readFile(rescuePath, 'utf8');
    const rescue = JSON.parse(rescueText);
    if (String(rescue.storeKey || '').trim().toUpperCase() !== storeKey) {
      throw new Error(`Fallback rescue store mismatch for ${rawEntry.path}`);
    }
    if (String(rescue.sourceGuard || '') !== String(plan.sourceGuard || '')) {
      throw new Error(`Fallback rescue sourceGuard mismatch for ${rawEntry.path}`);
    }
    if (String(rescue.purpose || '') !== `new_listing_or_relisted_top_treatment_limited_discount_fallback_${date}`) {
      throw new Error(`Fallback rescue purpose mismatch for ${rawEntry.path}`);
    }
    const rows = Array.isArray(rescue.rows) ? rescue.rows : [];
    if (!rows.length) throw new Error(`Fallback rescue file has no rows: ${rawEntry.path}`);
    if (Number(rawEntry.count) !== rows.length) {
      throw new Error(`Fallback rescue count mismatch for ${rawEntry.path}: plan=${rawEntry.count} actual=${rows.length}`);
    }
    if (rows.some(row => String(row?.storeKey || '').trim().toUpperCase() !== storeKey)) {
      throw new Error(`Fallback rescue contains a row for another store: ${rawEntry.path}`);
    }
    entries.push({
      ...rawEntry,
      storeKey,
      path: rescuePath,
      relativePath: normalizedRelative(resolvedRoot, rescuePath),
      contentHash: hashText(rescueText),
      rescue,
    });
  }

  const planHash = hashText(planText);
  const workFingerprint = hashText(JSON.stringify({
    planHash,
    guard: guardRelative,
    files: entries.map(entry => [entry.relativePath, entry.contentHash]),
  }));
  return {
    plan,
    planPath: resolvedPlanPath,
    planRelativePath: normalizedRelative(resolvedRoot, resolvedPlanPath),
    planHash,
    workFingerprint,
    entries,
  };
}
