/**
 * Marketing plan selection module.
 * P1-#1 refactor: extracted from build_marketing_daily_guard_report.mjs.
 */
import fsSync from 'node:fs';
import path from 'node:path';

export function resolveCurrentMarketingPlanPair({
  targetPlan = '',
  priceOverrides = '',
  targetPlanExplicit = false,
  priceOverridesExplicit = false,
  root = process.cwd(),
  nowMs = Date.now(),
} = {}) {
  if (targetPlanExplicit && priceOverridesExplicit) {
    return {targetPlan, priceOverrides, strategy: 'explicit_both'};
  }
  if (targetPlanExplicit) {
    const inferred = inferPairedMarketingPlanPath(targetPlan, 'selection-plan', 'price-overrides', root);
    if (!inferred) throw new Error(`--target-plan was provided but matching price-overrides file was not found: ${targetPlan}`);
    return {targetPlan, priceOverrides: priceOverrides || inferred, strategy: 'explicit_target_inferred_price'};
  }
  if (priceOverridesExplicit) {
    const inferred = inferPairedMarketingPlanPath(priceOverrides, 'price-overrides', 'selection-plan', root);
    if (!inferred) throw new Error(`--price-overrides was provided but matching selection-plan file was not found: ${priceOverrides}`);
    return {targetPlan: targetPlan || inferred, priceOverrides, strategy: 'explicit_price_inferred_target'};
  }
  const current = selectLatestMarketingPlanPair(root, nowMs);
  if (current) return {...current, strategy: 'auto_latest_current_pair'};
  const marketingSignupDir = path.join(root, 'tmp', 'marketing-signup');
  return {
    targetPlan: path.join(marketingSignupDir, 'selection-plan-2026-06-03-ALL-ready.json'),
    priceOverrides: path.join(marketingSignupDir, 'price-overrides-2026-06-03-ALL-ready.json'),
    strategy: 'legacy_fallback',
  };
}

function inferPairedMarketingPlanPath(file, fromToken, toToken, root) {
  const base = path.basename(file || '');
  if (!base.includes(fromToken)) return '';
  const candidate = path.join(path.dirname(file), base.replace(fromToken, toToken));
  return fsSync.existsSync(candidate) ? candidate : '';
}

function selectLatestMarketingPlanPair(root, nowMs = Date.now()) {
  const marketingSignupDir = path.join(root, 'tmp', 'marketing-signup');
  if (!fsSync.existsSync(marketingSignupDir)) return null;
  const candidates = [];
  const rejectedCandidates = [];
  const enabledStores = enabledStoreKeysForPlanSelection(root);
  for (const entry of fsSync.readdirSync(marketingSignupDir, {withFileTypes: true})) {
    if (!entry.isFile() || !/^selection-plan-.*\.json$/i.test(entry.name)) continue;
    const targetPlan = path.join(marketingSignupDir, entry.name);
    const priceOverrides = inferPairedMarketingPlanPath(targetPlan, 'selection-plan', 'price-overrides', root);
    if (!priceOverrides) {
      rejectedCandidates.push({targetPlan: path.relative(root, targetPlan), reason: 'missing_paired_price_overrides'});
      continue;
    }
    const stat = fsSync.statSync(targetPlan);
    const meta = marketingPlanCandidateMeta(targetPlan, priceOverrides, enabledStores, root, nowMs);
    if (meta.rejectReasons.length) {
      rejectedCandidates.push({targetPlan: path.relative(root, targetPlan), priceOverrides: path.relative(root, priceOverrides), rowCount: meta.rowCount, rejectReasons: meta.rejectReasons});
      continue;
    }
    candidates.push({targetPlan, priceOverrides, ...meta, mtimeMs: stat.mtimeMs});
  }
  candidates.sort((a, b) => {
    const aExplicit = Boolean(a.explicitCurrentBaseline);
    const bExplicit = Boolean(b.explicitCurrentBaseline);
    if (aExplicit !== bExplicit) return bExplicit - aExplicit;
    if (aExplicit && bExplicit) {
      const explicitWindowDiff = compareExplicitBaselineWindows(a.windowStats, b.windowStats);
      if (explicitWindowDiff) return explicitWindowDiff;
      const windowDiff = windowRank(b.windowStatus) - windowRank(a.windowStatus);
      if (windowDiff) return windowDiff;
      return b.effectiveCreatedMs - a.effectiveCreatedMs
        || b.score - a.score
        || b.mtimeMs - a.mtimeMs
        || String(a.targetPlan).localeCompare(String(b.targetPlan));
    }
    return b.score - a.score
      || b.mtimeMs - a.mtimeMs
      || String(a.targetPlan).localeCompare(String(b.targetPlan));
  });
  const selected = candidates[0] || null;
  return selected ? {...selected, rejectedCandidates: rejectedCandidates.slice(0, 50)} : null;
}

function marketingPlanCandidateMeta(file, priceFile, enabledStores = [], root, nowMs = Date.now()) {
  const name = path.basename(file).toLowerCase();
  let score = 0;
  const reasons = [];
  const rejectReasons = [];
  const add = (n, reason) => { score += n; reasons.push(`${n}:${reason}`); };
  const selectionDoc = readJsonSafe(file);
  const priceDoc = readJsonSafe(priceFile);
  if (!selectionDoc) rejectReasons.push('selection_parse_failed');
  if (!priceDoc) rejectReasons.push('price_overrides_parse_failed');
  if (selectionDoc?.scope?.repairOnly === true || priceDoc?.scope?.repairOnly === true) rejectReasons.push('scope_repair_only');
  const explicitCurrentBaseline = Boolean(
    selectionDoc?.baselineForNextOrdinaryActivity || priceDoc?.baselineForNextOrdinaryActivity
    || selectionDoc?.baselineForLimitedDiscountFallback || priceDoc?.baselineForLimitedDiscountFallback
  );
  const planMeta = selectionDoc?.planMetadata || priceDoc?.planMetadata || null;
  if (planMeta?.status === 'current_baseline' && !planMeta?.supersededBy) add(8000, 'plan_metadata_current_baseline');
  if (planMeta?.supersededBy) rejectReasons.push('plan_metadata_superseded');
  if (planMeta?.activityBatch) add(500, `plan_metadata_batch_${planMeta.activityBatch}`);
  const partialNamePattern = /\bpilot\b|sample|repair-|main-no-jsh/i;
  if (partialNamePattern.test(name) || (name.includes('all-safe') && !explicitCurrentBaseline)) rejectReasons.push('partial_or_subset_filename');
  const rowCount = itemRows(selectionDoc).length;
  const priceRowCount = itemRows(priceDoc).length;
  const windowStats = planWindowStats(itemRows(priceDoc).length ? itemRows(priceDoc) : itemRows(selectionDoc), nowMs);
  const windowStatus = windowStats.status;
  if (rowCount < 100) rejectReasons.push(`too_few_selection_rows_${rowCount}`);
  if (priceRowCount < 100) rejectReasons.push(`too_few_price_rows_${priceRowCount}`);
  if (rowCount !== priceRowCount) rejectReasons.push(`row_count_mismatch_${rowCount}_${priceRowCount}`);
  const storeCoverage = storeCoverageFromPlan(selectionDoc);
  if (enabledStores.length && !sameSet(storeCoverage, enabledStores)) rejectReasons.push(`store_coverage_mismatch_${storeCoverage.length}_of_${enabledStores.length}`);
  const alignment = planKeyAlignment(selectionDoc, priceDoc);
  if (!alignment.ok) rejectReasons.push(`key_alignment_mismatch_missingPrice_${alignment.missingPrice}_missingSelection_${alignment.missingSelection}`);
  if (rowCount >= 500) add(300, `full_rows_${rowCount}`);
  else if (rowCount >= 100) add(100, `medium_rows_${rowCount}`);
  else add(-500, `partial_rows_${rowCount}`);
  if (explicitCurrentBaseline) add(5000, 'explicit_current_baseline');
  if (name.includes('repaired')) add(500, 'repaired');
  if (name.includes('no-coupon')) add(1000, 'post_coupon_non_guaranteed_no_coupon_plan');
  if (name.includes('45162-45163')) add(350, 'latest_45162_45163_executed_plan');
  if (name.includes('user-remarks') || name.includes('userremarks')) add(200, 'user_remark_adjusted_plan');
  if (name.includes('gapfill7')) add(150, 'latest_live_gapfill7_plan');
  if (name.includes('include-excluded-approved')) add(450, 'include_excluded_approved');
  if (name.includes('t3-plus45488')) add(250, 't3_plus45488');
  if (name.includes('coupon-visible')) add(100, 'coupon_visible');
  if (name.includes('all-934')) add(250, 'all_934_current_approved');
  if (name.includes('43914-gapfill-high-exposure')) add(180, 'includes_43914_gapfill_high_exposure');
  if (name.includes('all-925')) add(-100, 'superseded_all_925');
  if (name.includes('all-919')) add(-200, 'superseded_all_919');
  if (name.includes('all-ready')) add(-700, 'legacy_all_ready');
  if (name.includes('pilot')) add(-700, 'pilot_partial');
  if (name.includes('repair-')) add(-650, 'repair_only');
  if (name.includes('main-no-jsh')) add(-300, 'main_no_jsh_subset');
  if (name.includes('all-safe')) add(explicitCurrentBaseline ? 100 : -150, explicitCurrentBaseline ? 'current_baseline_all_safe' : 'pre_approved_safe_subset');
  const createdMs = Math.max(
    dateToMs(selectionDoc?.createdAt),
    dateToMs(priceDoc?.createdAt),
    fsSync.statSync(file).mtimeMs,
    fsSync.statSync(priceFile).mtimeMs,
  );
  return {score, rowCount, priceRowCount, storeCoverage, keyAlignment: alignment, scoreReasons: reasons, rejectReasons, explicitCurrentBaseline, effectiveCreatedMs: createdMs, windowStatus, windowStats};
}

function readJsonSafe(file) { try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return null; } }
function itemRows(doc) { if (Array.isArray(doc?.items)) return doc.items; if (Array.isArray(doc?.selection)) return doc.selection; if (Array.isArray(doc?.rows)) return doc.rows; return []; }
function storeCoverageFromPlan(doc) { const declared = Array.isArray(doc?.scope?.storeKeys) ? doc.scope.storeKeys : (Array.isArray(doc?.stores) ? doc.stores : []); const fromRows = itemRows(doc).map(row => row?.storeKey || row?.store || '').filter(Boolean); return [...new Set([...declared, ...fromRows].map(normalizeStoreKeyForPlanSelection).filter(Boolean))].sort(); }
function enabledStoreKeysForPlanSelection(root) { try { const doc = JSON.parse(fsSync.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8')); return (doc.stores || []).filter(s => s.enabled !== false).map(s => normalizeStoreKeyForPlanSelection(s.storeKey)).filter(Boolean).sort(); } catch { return []; } }
function planKeyAlignment(selectionDoc, priceDoc) { const selectionKeys = new Set(itemRows(selectionDoc).map(planRowKey).filter(Boolean)); const priceKeys = new Set(itemRows(priceDoc).map(planRowKey).filter(Boolean)); let missingPrice = 0; let missingSelection = 0; for (const key of selectionKeys) if (!priceKeys.has(key)) missingPrice += 1; for (const key of priceKeys) if (!selectionKeys.has(key)) missingSelection += 1; return {ok: missingPrice === 0 && missingSelection === 0 && selectionKeys.size > 0, selectionKeys: selectionKeys.size, priceKeys: priceKeys.size, missingPrice, missingSelection}; }
function planRowKey(row) { const storeKey = normalizeStoreKeyForPlanSelection(row?.storeKey || row?.store); const activityId = Number(row?.activityId || row?.activity_id || 0); const skc = String(row?.skc || row?.SKC || '').trim(); return storeKey && activityId && skc ? `${storeKey}__${activityId}__${skc}` : ''; }
function normalizeStoreKeyForPlanSelection(value) { return String(value || '').trim().toUpperCase(); }
function sameSet(a = [], b = []) { if (a.length !== b.length) return false; const aa = [...a].sort(); const bb = [...b].sort(); return aa.every((value, idx) => value === bb[idx]); }
function planWindowStats(rows = [], nowMs = Date.now()) {
  let active = 0;
  let future = 0;
  let expired = 0;
  let unknown = 0;
  let earliestFutureMs = 0;
  let latestActiveEndMs = 0;
  let latestExpiredEndMs = 0;
  for (const row of rows) {
    const startMs = dateToMs(row?.eventStart || row?.planStartTime || row?.activityStartTime || row?.startTime || row?.activity_start || row?.marketing_activity_start);
    const endMs = dateToMs(row?.eventEnd || row?.planEndTime || row?.activityEndTime || row?.endTime || row?.activity_end || row?.marketing_activity_end);
    if (startMs && startMs > nowMs) {
      future += 1;
      if (!earliestFutureMs || startMs < earliestFutureMs) earliestFutureMs = startMs;
      continue;
    }
    if (endMs && endMs < nowMs) {
      expired += 1;
      if (!latestExpiredEndMs || endMs > latestExpiredEndMs) latestExpiredEndMs = endMs;
      continue;
    }
    if (startMs || endMs) {
      active += 1;
      if (endMs && endMs > latestActiveEndMs) latestActiveEndMs = endMs;
    } else {
      unknown += 1;
    }
  }
  const total = rows.length;
  const status = active > 0 ? 'active' : future > 0 ? 'future' : expired > 0 ? 'expired' : 'unknown';
  return {
    status,
    total,
    active,
    future,
    expired,
    unknown,
    currentOrFuture: active + future,
    activeRatio: total ? active / total : 0,
    futureRatio: total ? future / total : 0,
    expiredRatio: total ? expired / total : 0,
    earliestFutureMs,
    latestActiveEndMs,
    latestExpiredEndMs,
  };
}
function compareExplicitBaselineWindows(a = {}, b = {}) {
  const aActive = Number(a.active || 0);
  const bActive = Number(b.active || 0);
  if (aActive || bActive) {
    // After a newer campaign actually starts, prefer the baseline that covers
    // the larger active window. This prevents a mostly-expired previous batch
    // with a tiny overlapping tail from masking the newly-effective plan.
    if (aActive !== bActive) return bActive - aActive;
    const aEnd = Number(a.latestActiveEndMs || 0);
    const bEnd = Number(b.latestActiveEndMs || 0);
    if (aEnd !== bEnd) return bEnd - aEnd;
    return 0;
  }
  const aFuture = Number(a.future || 0);
  const bFuture = Number(b.future || 0);
  if (aFuture || bFuture) {
    if (aFuture && bFuture) {
      const aStart = Number(a.earliestFutureMs || 0);
      const bStart = Number(b.earliestFutureMs || 0);
      if (aStart && bStart && aStart !== bStart) return aStart - bStart;
      if (aFuture !== bFuture) return bFuture - aFuture;
      return 0;
    }
    return bFuture - aFuture;
  }
  const aExpiredEnd = Number(a.latestExpiredEndMs || 0);
  const bExpiredEnd = Number(b.latestExpiredEndMs || 0);
  if (aExpiredEnd !== bExpiredEnd) return bExpiredEnd - aExpiredEnd;
  return 0;
}
function windowRank(status) {
  switch (status) {
    case 'active':
      return 3;
    case 'future':
      return 2;
    case 'unknown':
      return 1;
    case 'expired':
      return 0;
    default:
      return 1;
  }
}
export function parseMarketingDateMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const dateOnly = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const normalized = dateOnly
    ? `${dateOnly[1]}-${String(dateOnly[2]).padStart(2, '0')}-${String(dateOnly[3]).padStart(2, '0')}T00:00:00`
    : raw.replace(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (_, year, month, day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`).replace(/\s+/, 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : 0;
}

function dateToMs(value) {
  return parseMarketingDateMs(value);
}
