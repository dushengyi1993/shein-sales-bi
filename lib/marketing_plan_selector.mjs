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
  const current = selectLatestMarketingPlanPair(root);
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

function selectLatestMarketingPlanPair(root) {
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
    const meta = marketingPlanCandidateMeta(targetPlan, priceOverrides, enabledStores, root);
    if (meta.rejectReasons.length) {
      rejectedCandidates.push({targetPlan: path.relative(root, targetPlan), priceOverrides: path.relative(root, priceOverrides), rowCount: meta.rowCount, rejectReasons: meta.rejectReasons});
      continue;
    }
    candidates.push({targetPlan, priceOverrides, ...meta, mtimeMs: stat.mtimeMs});
  }
  candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs || String(a.targetPlan).localeCompare(String(b.targetPlan)));
  const selected = candidates[0] || null;
  return selected ? {...selected, rejectedCandidates: rejectedCandidates.slice(0, 50)} : null;
}

function marketingPlanCandidateMeta(file, priceFile, enabledStores = [], root) {
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
  const partialNamePattern = /\bpilot\b|sample|repair-|(?:^|-)jsh(?:-|\.json)|main-no-jsh/i;
  if (partialNamePattern.test(name) || (name.includes('all-safe') && !explicitCurrentBaseline)) rejectReasons.push('partial_or_subset_filename');
  const rowCount = itemRows(selectionDoc).length;
  const priceRowCount = itemRows(priceDoc).length;
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
  if (name.includes('-jsh')) add(-300, 'jsh_subset');
  if (name.includes('main-no-jsh')) add(-300, 'main_no_jsh_subset');
  if (name.includes('all-safe')) add(explicitCurrentBaseline ? 100 : -150, explicitCurrentBaseline ? 'current_baseline_all_safe' : 'pre_approved_safe_subset');
  return {score, rowCount, priceRowCount, storeCoverage, keyAlignment: alignment, scoreReasons: reasons, rejectReasons};
}

function readJsonSafe(file) { try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return null; } }
function itemRows(doc) { if (Array.isArray(doc?.items)) return doc.items; if (Array.isArray(doc?.selection)) return doc.selection; if (Array.isArray(doc?.rows)) return doc.rows; return []; }
function storeCoverageFromPlan(doc) { const declared = Array.isArray(doc?.scope?.storeKeys) ? doc.scope.storeKeys : (Array.isArray(doc?.stores) ? doc.stores : []); const fromRows = itemRows(doc).map(row => row?.storeKey || row?.store || '').filter(Boolean); return [...new Set([...declared, ...fromRows].map(normalizeStoreKeyForPlanSelection).filter(Boolean))].sort(); }
function enabledStoreKeysForPlanSelection(root) { try { const doc = JSON.parse(fsSync.readFileSync(path.join(root, 'config', 'stores.json'), 'utf8')); return (doc.stores || []).filter(s => s.enabled !== false).map(s => normalizeStoreKeyForPlanSelection(s.storeKey)).filter(Boolean).sort(); } catch { return []; } }
function planKeyAlignment(selectionDoc, priceDoc) { const selectionKeys = new Set(itemRows(selectionDoc).map(planRowKey).filter(Boolean)); const priceKeys = new Set(itemRows(priceDoc).map(planRowKey).filter(Boolean)); let missingPrice = 0; let missingSelection = 0; for (const key of selectionKeys) if (!priceKeys.has(key)) missingPrice += 1; for (const key of priceKeys) if (!selectionKeys.has(key)) missingSelection += 1; return {ok: missingPrice === 0 && missingSelection === 0 && selectionKeys.size > 0, selectionKeys: selectionKeys.size, priceKeys: priceKeys.size, missingPrice, missingSelection}; }
function planRowKey(row) { const storeKey = normalizeStoreKeyForPlanSelection(row?.storeKey || row?.store); const activityId = Number(row?.activityId || row?.activity_id || 0); const skc = String(row?.skc || row?.SKC || '').trim(); return storeKey && activityId && skc ? `${storeKey}__${activityId}__${skc}` : ''; }
function normalizeStoreKeyForPlanSelection(value) { return String(value || '').trim().toUpperCase(); }
function sameSet(a = [], b = []) { if (a.length !== b.length) return false; const aa = [...a].sort(); const bb = [...b].sort(); return aa.every((value, idx) => value === bb[idx]); }
