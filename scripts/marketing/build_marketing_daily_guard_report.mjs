#!/usr/bin/env node
/**
 * Build a read-only daily guard report for SHEIN marketing automation.
 *
 * This script intentionally does not call SHEIN, launch browsers, submit
 * activities, cancel coupons, edit budgets, or modify limited discounts. It
 * only summarizes existing scan/audit artifacts so heartbeat automation can
 * report from stable evidence instead of re-interpreting files ad hoc.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_CLOUD_BI_ROOT as SHARED_DEFAULT_CLOUD_BI_ROOT,
  DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS as SHARED_DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
  DEFAULT_CLOUD_BI_MAX_BYTES as SHARED_DEFAULT_CLOUD_BI_MAX_BYTES,
  selectBiPortalSource as selectSharedBiPortalSource,
} from '../../lib/bi_portal_source.mjs';
import {
  couponPlanStoreView,
  loadCouponTargetEligibilityPlan,
} from '../../lib/marketing_coupon_policy.mjs';
import {summarizeCouponBudgetStatus} from '../../lib/marketing_coupon_budget_guard.mjs';
import {
  classifyKnownOrdinaryCouponStack,
  groupOrdinaryEvidenceBySkc,
  loadKnownOrdinaryPriceEvidence,
} from '../../lib/marketing_ordinary_price_evidence.mjs';
import {summarizeStackReviewCoverage} from '../../lib/marketing_stack_review_coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const DEFAULT_MAX_AGE_HOURS = 72;
const TARGET_PLAN_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'selection-plan-2026-06-03-ALL-ready.json');
const PRICE_OVERRIDES_DEFAULT = path.join(ROOT, 'tmp', 'marketing-signup', 'price-overrides-2026-06-03-ALL-ready.json');
const BI_PORTAL_DATA_DEFAULT = path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const STORES_CONFIG_DEFAULT = path.join(ROOT, 'config', 'stores.json');
const COUPON_CANCEL_RESULTS_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-cancel-results');
const NEW_SKC_SHELF_AGE_DAYS = 30;
const NEW_SKC_MAX_ROWS = 80;
const DEFAULT_CLOUD_BI_ROOT = SHARED_DEFAULT_CLOUD_BI_ROOT;
const DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS = SHARED_DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS;
const DEFAULT_CLOUD_BI_MAX_BYTES = SHARED_DEFAULT_CLOUD_BI_MAX_BYTES;
const MARKETING_STACK_REVIEW_MAX_AGE_HOURS = 48;
const CRITICAL_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
  'marketingStackReview',
  'targetSelectionPlan',
  'priceOverridesPlan',
  'storesConfig',
]);
const STALE_BLOCKER_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
]);

function parseArgs(argv) {
  const args = {
    date: formatLocalDate(new Date()),
    outDir: DEFAULT_OUT_DIR,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    biPortalData: BI_PORTAL_DATA_DEFAULT,
    targetPlan: TARGET_PLAN_DEFAULT,
    priceOverrides: PRICE_OVERRIDES_DEFAULT,
    storesConfig: STORES_CONFIG_DEFAULT,
    cloudBiSsh: '',
    cloudBiRoot: DEFAULT_CLOUD_BI_ROOT,
    cloudBiSshTimeoutMs: DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
    cloudBiMaxBytes: DEFAULT_CLOUD_BI_MAX_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
    else if (a === '--bi-portal-data') args.biPortalData = path.resolve(argv[++i]);
    else if (a === '--target-plan') args.targetPlan = path.resolve(argv[++i]);
    else if (a === '--price-overrides') args.priceOverrides = path.resolve(argv[++i]);
    else if (a === '--stores-config') args.storesConfig = path.resolve(argv[++i]);
    else if (a === '--cloud-bi-ssh') args.cloudBiSsh = String(argv[++i] || '').trim();
    else if (a === '--cloud-bi-root') args.cloudBiRoot = String(argv[++i] || '').trim();
    else if (a === '--cloud-bi-ssh-timeout-ms') args.cloudBiSshTimeoutMs = Number(argv[++i]);
    else if (a === '--cloud-bi-max-bytes') args.cloudBiMaxBytes = Number(argv[++i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours <= 0) args.maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(args.cloudBiSshTimeoutMs) || args.cloudBiSshTimeoutMs <= 0) args.cloudBiSshTimeoutMs = DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS;
  if (!Number.isFinite(args.cloudBiMaxBytes) || args.cloudBiMaxBytes <= 0) args.cloudBiMaxBytes = DEFAULT_CLOUD_BI_MAX_BYTES;
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function rel(file) {
  if (!file) return '';
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function exists(file) {
  return Boolean(file && fsSync.existsSync(file));
}

function parseLocalDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
}

function parseAnyDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const parsed = new Date(s);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return parseLocalDateTime(s);
}

function ageHours(now, then) {
  if (!now || !then) return null;
  return Math.round(((now.getTime() - then.getTime()) / 36_000)) / 100;
}

function listFiles(dir, regex) {
  if (!fsSync.existsSync(dir)) return [];
  return fsSync.readdirSync(dir, {withFileTypes: true})
    .filter(d => d.isFile() && regex.test(d.name))
    .map(d => path.join(dir, d.name))
    .sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs);
}

function latestFile(dir, regex) {
  return listFiles(dir, regex)[0] || '';
}

function mapKeys(map) {
  return map ? [...map.keys()] : [];
}

async function readJsonIfExists(file, fallback = null) {
  if (!exists(file)) return fallback;
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

async function readSource(label, file, now, maxAgeHours) {
  const source = {
    label,
    path: rel(file),
    exists: exists(file),
    mtime: '',
    generatedAt: '',
    createdAt: '',
    ageHours: null,
    status: 'missing',
  };
  if (!source.exists) return {source, data: null};
  const stat = fsSync.statSync(file);
  source.mtime = stat.mtime.toISOString();
  source.artifactAgeHours = ageHours(now, stat.mtime);
  source.ageHours = source.artifactAgeHours;
  try {
    const data = await readJsonIfExists(file, null);
    source.generatedAt = data?.generatedAt || data?.source?.biGeneratedAt || '';
    source.createdAt = data?.createdAt || data?.summary?.createdAt || '';
    source.dataTimestamp = source.generatedAt || source.createdAt || '';
    const dataDate = parseAnyDateTime(source.dataTimestamp);
    source.dataAgeHours = dataDate ? ageHours(now, dataDate) : null;
    source.status = (
      (source.artifactAgeHours !== null && source.artifactAgeHours > maxAgeHours)
      || (source.dataAgeHours !== null && source.dataAgeHours > maxAgeHours)
    ) ? 'stale' : 'ok';
    return {source, data};
  } catch (err) {
    source.status = 'parse_error';
    source.error = err.message;
    return {source, data: null};
  }
}

function sourceFromData(label, sourcePath, data, now, maxAgeHours, extra = {}) {
  const source = {
    label,
    path: sourcePath,
    exists: true,
    mtime: '',
    generatedAt: data?.generatedAt || data?.source?.biGeneratedAt || '',
    createdAt: data?.createdAt || data?.summary?.createdAt || '',
    ageHours: null,
    status: 'ok',
    ...extra,
  };
  source.dataTimestamp = source.generatedAt || source.createdAt || '';
  const dataDate = parseAnyDateTime(source.dataTimestamp);
  source.dataAgeHours = dataDate ? ageHours(now, dataDate) : null;
  source.artifactAgeHours = null;
  source.ageHours = source.dataAgeHours;
  if (source.dataAgeHours !== null && source.dataAgeHours > maxAgeHours) source.status = 'stale';
  return source;
}

function normalizeMarketingStackReviewSource(item, now, maxAgeHours) {
  if (!item?.source || item.source.status === 'missing' || item.source.status === 'parse_error') return null;
  const data = item.data || {};
  const source = item.source;
  const activityScanCreatedAt = data.activityScanCreatedAt || data.createdAt || source.createdAt || '';
  const rebuiltAt = data.rebuiltAt || '';
  const createdAt = activityScanCreatedAt;
  const createdDate = parseAnyDateTime(createdAt);
  const activityAgeHours = createdDate ? ageHours(now, createdDate) : source.artifactAgeHours;
  const thresholdHours = Math.min(Number(maxAgeHours || DEFAULT_MAX_AGE_HOURS), MARKETING_STACK_REVIEW_MAX_AGE_HOURS);
  const biContextGeneratedAt = data.source?.biGeneratedAt || '';
  const biContextDate = parseAnyDateTime(biContextGeneratedAt);
  const biContextAgeHours = biContextDate ? ageHours(now, biContextDate) : null;
  source.generatedAt = data.generatedAt || '';
  source.createdAt = createdAt;
  source.dataTimestamp = createdAt || source.mtime || '';
  source.dataAgeHours = activityAgeHours;
  source.ageHours = activityAgeHours;
  source.activityAgeHours = activityAgeHours;
  source.activityFreshnessThresholdHours = thresholdHours;
  source.biContextGeneratedAt = biContextGeneratedAt;
  source.biContextAgeHours = biContextAgeHours;
  source.biContextStale = biContextAgeHours !== null && biContextAgeHours > maxAgeHours;
  source.biContextSource = data.source?.biLinkDate || data.source?.biLinkUpdatedAt || '';
  source.rebuiltAt = rebuiltAt;
  if (
    (source.artifactAgeHours !== null && source.artifactAgeHours > thresholdHours)
    || (activityAgeHours !== null && activityAgeHours > thresholdHours)
  ) {
    source.status = 'stale';
  } else {
    source.status = 'ok';
  }
  return {
    biContextGeneratedAt,
    biContextAgeHours,
    biContextStale: source.biContextStale,
    biContextSource: source.biContextSource,
    activityScanCreatedAt,
    activityScanFinishedAt: data.activityScanFinishedAt || '',
    rebuiltAt,
    activityAgeHours,
    activityFreshnessThresholdHours: thresholdHours,
  };
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row?.[field] || '(empty)');
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function buildStackDetailIndex(stackDoc) {
  const map = new Map();
  const detailRows = Array.isArray(stackDoc?.detailRows) ? stackDoc.detailRows : [];
  for (const row of detailRows) {
    const storeKey = String(row['店铺'] || row.storeKey || row.store || '').trim().toUpperCase();
    const skc = String(row.SKC || row.skc || '').trim();
    if (!storeKey || !skc) continue;
    const key = `${storeKey}__${skc}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function hasExistingOrdinaryMarketingLabel(stackRows) {
  return (stackRows || []).some(row => {
    const text = [
      row?.['普通营销活动价/折扣'],
      row?.['风险提示'],
      row?.ordinaryMarketingSummary,
      row?.risk,
    ].filter(Boolean).join(' ');
    return /既有(?:普通活动)?标签|既有普通营销活动|旧普通活动|度假季/.test(text);
  });
}

function countOrderStatuses(orderAuditFiles) {
  const statusCounts = {};
  let rows = 0;
  const samples = [];
  for (const doc of orderAuditFiles) {
    for (const row of doc?.rows || []) {
      rows += 1;
      const status = String(row.status || row.reason || 'unknown');
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      if (samples.length < 10) {
        samples.push({
          storeKey: row.storeKey,
          orderNo: row.orderNo,
          skc: row.skc,
          canonical: row.canonical,
          currencyPrice: row.currencyPrice,
          finalTargetPrice: row.finalTargetPrice,
          deltaSar: row.deltaSar,
          planWindowStatus: row.planWindowStatus,
          status: row.status,
        });
      }
    }
  }
  return {
    files: orderAuditFiles.length,
    rows,
    below: statusCounts.below_target || 0,
    above: statusCounts.above_target || 0,
    outsideWindow: statusCounts.outside_plan_window || 0,
    grainUnknown: statusCounts.grain_unknown || 0,
    missingPlan: statusCounts.missing_plan || 0,
    statusCounts,
    samples,
  };
}

function summarizeCouponSubmit(doc) {
  if (!doc) return {status: 'unknown'};
  const stores = Array.isArray(doc.stores) ? doc.stores : [];
  const identityFailures = stores
    .filter(s => s?.identity && s.identity.ok === false)
    .map(s => ({store: s.store, reason: s.identity.reason || s.identity.error || 'identity_failed'}));
  return {
    status: doc.dryRun === true ? 'ok' : 'untrusted',
    summaryPath: '',
    dryRun: doc.dryRun === true,
    ok: doc.ok,
    okStores: doc.totals?.okStores ?? stores.filter(s => s.ok).length,
    failedStores: doc.totals?.failedStores ?? stores.filter(s => !s.ok).length,
    targetCount: doc.totals?.targetCount ?? stores.reduce((n, s) => n + Number(s.target?.targetCount || 0), 0),
    toSubmit: doc.totals?.toSubmit ?? stores.reduce((n, s) => n + Number(s.target?.toSubmit || 0), 0),
    identityFailures,
  };
}

function summarizeLowPriceOverlap(liveDoc, cancelDoc) {
  const stores = Array.isArray(liveDoc?.stores) ? liveDoc.stores : [];
  const priceDecisionCounts = liveDoc?.priceDecisionCounts || {};
  return {
    meaning: 'limited_discount_coupon_scan; above means limited-fallback coupon final is above target, not final transaction price',
    belowTarget: Number(liveDoc?.activeCouponBelowTargetCount || 0),
    missingEvidence: Number(liveDoc?.activeCouponMissingPriceEvidenceCount || 0),
    matchesTarget: Number(priceDecisionCounts.coupon_final_matches_target || 0),
    limitedFallbackAboveTarget: Number(priceDecisionCounts.coupon_final_above_target || 0),
    aboveTarget: Number(priceDecisionCounts.coupon_final_above_target || 0),
    cancelRows: Array.isArray(cancelDoc?.rows) ? cancelDoc.rows.length : 0,
    allStoresOk: stores.length > 0 ? stores.every(s => s.ok !== false) : null,
    storeCount: stores.length,
  };
}

function summarizeOldOrdinaryOverlap(liveDoc, cancelDoc) {
  return {
    riskCancel: cancelDoc?.riskCancel === true,
    cancelRows: Array.isArray(cancelDoc?.rows) ? cancelDoc.rows.length : 0,
    observationRows: Number(liveDoc?.activeCouponObservationCount || 0),
    riskRows: Number(liveDoc?.activeCouponRiskCount || 0),
    storeCount: Array.isArray(liveDoc?.stores) ? liveDoc.stores.length : 0,
    allStoresOk: Array.isArray(liveDoc?.stores) && liveDoc.stores.length ? liveDoc.stores.every(s => s.ok !== false) : null,
  };
}

async function loadKnownOrdinaryCancelMitigation(reportDate) {
  const pairs = [];
  const addPair = (date, targetPath, verificationPath) => {
    if (!targetPath) return;
    if (date && date > reportDate) return;
    if (pairs.some(pair => pair.targetPath === targetPath)) return;
    pairs.push({date, targetPath, verificationPath});
  };
  if (fsSync.existsSync(COUPON_CANCEL_RESULTS_DIR)) {
    for (const entry of fsSync.readdirSync(COUPON_CANCEL_RESULTS_DIR, {withFileTypes: true})) {
      if (!entry.isFile()) continue;
      const match = entry.name.match(/^known-ordinary-coupon-cancel-targets-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!match) continue;
      const date = match[1];
      addPair(
        date,
        path.join(COUPON_CANCEL_RESULTS_DIR, entry.name),
        path.join(DEFAULT_OUT_DIR, `known-ordinary-coupon-post-cancel-verification-${date}.json`),
      );
    }
  }
  addPair(
    reportDate,
    path.join(COUPON_CANCEL_RESULTS_DIR, `known-ordinary-coupon-cancel-targets-${reportDate}.json`),
    path.join(DEFAULT_OUT_DIR, `known-ordinary-coupon-post-cancel-verification-${reportDate}.json`),
  );
  pairs.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.targetPath).localeCompare(String(b.targetPath)));
  const mitigatedSkcs = new Set();
  const verifiedPairs = [];
  const incompletePairs = [];
  let targetRowsCount = 0;
  let verificationExists = 0;
  let remainingCancelTargets = 0;
  let failedStores = 0;
  for (const pair of pairs) {
    const targetDoc = await readJsonIfExists(pair.targetPath, null);
    const verificationDoc = await readJsonIfExists(pair.verificationPath, null);
    const targetRows = Array.isArray(targetDoc?.rows) ? targetDoc.rows : [];
    if (!targetRows.length && !verificationDoc) continue;
    targetRowsCount += targetRows.length;
    if (verificationDoc) verificationExists += 1;
    const remaining = Number(verificationDoc?.total?.remainingCancelTargets);
    const failed = Number(verificationDoc?.total?.failedStores);
    if (Number.isFinite(remaining)) remainingCancelTargets += remaining;
    if (Number.isFinite(failed)) failedStores += failed;
    const verified = Boolean(targetRows.length && verificationDoc && remaining === 0 && failed === 0);
    if (verified) verifiedPairs.push({...pair, targetRows: targetRows.length});
    else incompletePairs.push({
      ...pair,
      targetRows: targetRows.length,
      verificationExists: Boolean(verificationDoc),
      remainingCancelTargets: Number.isFinite(remaining) ? remaining : null,
      failedStores: Number.isFinite(failed) ? failed : null,
    });
    if (!verified) continue;
    for (const row of targetRows) {
      const storeKey = String(row?.storeKey || '').toUpperCase();
      const skc = String(row?.skc || '').trim();
      if (storeKey && skc) mitigatedSkcs.add(`${storeKey}__${skc}`);
    }
  }
  return {
    status: verifiedPairs.length && !incompletePairs.length
      ? 'verified_cancelled'
      : (verifiedPairs.length ? 'verified_cancelled_with_incomplete_history' : (targetRowsCount || verificationExists ? 'incomplete' : 'missing')),
    targetPath: verifiedPairs.length ? rel(verifiedPairs.at(-1).targetPath) : (pairs.at(-1)?.targetPath ? rel(pairs.at(-1).targetPath) : ''),
    verificationPath: verifiedPairs.length ? rel(verifiedPairs.at(-1).verificationPath) : (pairs.at(-1)?.verificationPath ? rel(pairs.at(-1).verificationPath) : ''),
    targetPaths: verifiedPairs.map(pair => rel(pair.targetPath)),
    verificationPaths: verifiedPairs.map(pair => rel(pair.verificationPath)),
    targetRows: targetRowsCount,
    verificationExists,
    verifiedPairs: verifiedPairs.map(pair => ({
      date: pair.date,
      targetPath: rel(pair.targetPath),
      verificationPath: rel(pair.verificationPath),
      targetRows: pair.targetRows,
    })),
    incompletePairs: incompletePairs.map(pair => ({
      date: pair.date,
      targetPath: rel(pair.targetPath),
      verificationPath: rel(pair.verificationPath),
      targetRows: pair.targetRows,
      verificationExists: pair.verificationExists,
      remainingCancelTargets: pair.remainingCancelTargets,
      failedStores: pair.failedStores,
    })),
    remainingCancelTargets,
    failedStores,
    mitigatedSkcs,
  };
}

function summarizeKnownOrdinaryActivityGuard({couponPlan, ordinaryEvidenceByStore, stackDoc, cancelMitigation}) {
  const detailIndex = buildStackDetailIndex(stackDoc);
  const storeKeys = [...new Set([
    ...mapKeys(couponPlan?.rowsByStore),
    ...mapKeys(couponPlan?.allowed15ByStore || couponPlan?.byStore),
  ])].sort();
  const rows = [];
  const belowRows = [];
  const incompleteRows = [];
  const missingTargetRows = [];
  const decisionCounts = {};
  const belowByStore = {};
  const evidenceTrustCounts = {};
  const mitigatedRows = [];
  const mitigatedByStore = {};
  let allowed15PlanCount = 0;
  let withKnownOrdinaryEvidenceCount = 0;
  let noOrdinaryLabelCount = 0;

  for (const storeKey of storeKeys) {
    const view = couponPlanStoreView(couponPlan, storeKey);
    const evidence = ordinaryEvidenceByStore.get(storeKey);
    const bySkc = evidence?.bySkc || new Map();
    for (const planRow of view.rows.filter(r => r.allowed15)) {
      allowed15PlanCount += 1;
      const key = `${storeKey}__${planRow.skc}`;
      const stackRows = detailIndex.get(key) || [];
      const evidenceRows = bySkc.get(planRow.skc) || [];
      if (evidenceRows.length) {
        withKnownOrdinaryEvidenceCount += 1;
        const priceGuard = classifyKnownOrdinaryCouponStack(evidenceRows, planRow, {fallbackDiscountPct: 15});
        decisionCounts[priceGuard.decision] = (decisionCounts[priceGuard.decision] || 0) + 1;
        const out = {
          storeKey,
          skc: planRow.skc,
          canonical: planRow.canonical,
          activityId: planRow.activityId,
          decision: priceGuard.decision,
          lowestOrdinaryPrice: priceGuard.lowestOrdinaryPrice,
          ordinaryActivityId: priceGuard.lowestOrdinaryEvidence?.activityId || '',
          ordinaryActivityName: priceGuard.lowestOrdinaryEvidence?.activityName || '',
          ordinaryEventStart: priceGuard.lowestOrdinaryEvidence?.eventStart || '',
          ordinaryEventEnd: priceGuard.lowestOrdinaryEvidence?.eventEnd || '',
          ordinaryEvidenceTrust: priceGuard.lowestOrdinaryEvidence?.evidenceTrust || '',
          ordinaryEvidenceSource: priceGuard.lowestOrdinaryEvidence?.fillSource || '',
          couponFactor: priceGuard.couponFactor,
          finalWithCoupon: priceGuard.finalWithCoupon,
          finalTargetPrice: priceGuard.finalTargetPrice,
          diff: priceGuard.diff,
          shouldCancelCoupon: priceGuard.shouldCancelCoupon,
        };
        if (!priceGuard.allowSubmit) rows.push(out);
        if (priceGuard.decision === 'known_ordinary_final_below_target') {
          const mitigationKey = `${storeKey}__${planRow.skc}`;
          if (cancelMitigation?.mitigatedSkcs?.has(mitigationKey)) {
            out.mitigationStatus = 'coupon_cancelled_verified';
            out.mitigationSource = cancelMitigation.verificationPath;
            mitigatedRows.push(out);
            mitigatedByStore[storeKey] = (mitigatedByStore[storeKey] || 0) + 1;
            const idx = rows.indexOf(out);
            if (idx >= 0) rows.splice(idx, 1);
          } else {
            belowRows.push(out);
            belowByStore[storeKey] = (belowByStore[storeKey] || 0) + 1;
            const trust = out.ordinaryEvidenceTrust || 'unknown';
            evidenceTrustCounts[trust] = (evidenceTrustCounts[trust] || 0) + 1;
          }
        }
        if (priceGuard.decision === 'missing_final_target_price') missingTargetRows.push(out);
        continue;
      }

      if (hasExistingOrdinaryMarketingLabel(stackRows)) {
        const out = {
          storeKey,
          skc: planRow.skc,
          canonical: planRow.canonical,
          activityId: planRow.activityId,
          decision: 'known_ordinary_evidence_incomplete',
          reason: 'stack_review_has_existing_ordinary_label_but_no_known_ordinary_price',
          couponFactor: planRow.couponFactor,
          finalTargetPrice: planRow.finalTargetPrice,
          stackReviewSamples: stackRows.slice(0, 3).map(row => ({
            activityId: row['活动ID'] || '',
            activityName: row['活动名称'] || '',
            eventStart: row['普通活动开始'] || '',
            eventEnd: row['普通活动结束'] || '',
            ordinarySummary: row['普通营销活动价/折扣'] || '',
            risk: row['风险提示'] || '',
          })),
        };
        rows.push(out);
        incompleteRows.push(out);
      } else {
        noOrdinaryLabelCount += 1;
      }
    }
  }

  return {
    policy: 'allowed15_known_ordinary_activity_price_stack_guard',
    meaning: '旧普通营销活动填报价也属于最低促销基准价；若其叠加15%券低于目标价，日报必须阻断',
    allowed15PlanCount,
    withKnownOrdinaryEvidenceCount,
    noOrdinaryLabelCount,
    belowTargetCount: belowRows.length,
    mitigatedBelowTargetCount: mitigatedRows.length,
    evidenceIncompleteCount: incompleteRows.length,
    missingFinalTargetPriceCount: missingTargetRows.length,
    decisionCounts,
    belowByStore,
    mitigatedByStore,
    evidenceTrustCounts,
    cancelMitigation: cancelMitigation ? {
      status: cancelMitigation.status,
      targetPath: cancelMitigation.targetPath,
      verificationPath: cancelMitigation.verificationPath,
      targetRows: cancelMitigation.targetRows,
      remainingCancelTargets: cancelMitigation.remainingCancelTargets,
      failedStores: cancelMitigation.failedStores,
    } : null,
    blockerRows: rows.slice(0, 500),
    belowTargetRows: belowRows.slice(0, 500),
    mitigatedBelowTargetRows: mitigatedRows.slice(0, 500),
    evidenceIncompleteRows: incompleteRows.slice(0, 50),
    missingFinalTargetPriceRows: missingTargetRows.slice(0, 50),
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function classifyFallbackPriceStack(row) {
  const couponFactor = numberOrNull(row.couponFactor);
  const targetFinalPrice = numberOrNull(row.targetFinalPrice ?? row.finalTargetPrice);
  const limitedDiscountPrice = numberOrNull(row.limitedDiscountPrice);
  const ordinaryMarketingPrice = numberOrNull(
    row.ordinaryMarketingPrice
    ?? row.effectiveOrdinaryMarketingPrice
    ?? row.ordinaryActivityPrice
  );
  const ordinaryCoverageConfirmedAbsent = row.ordinaryCoverageConfirmedAbsent === true
    || row.noOrdinaryMarketingActivity === true;
  const currentSellingPrice = numberOrNull(row.currentSellingPrice ?? row.currentPrice ?? row.salePrice);
  const candidates = [];
  if (ordinaryMarketingPrice !== null) {
    candidates.push({source: 'ordinary_marketing', price: ordinaryMarketingPrice});
  }
  if (limitedDiscountPrice !== null) {
    candidates.push({source: 'limited_discount', price: limitedDiscountPrice});
  }
  if (currentSellingPrice !== null) {
    candidates.push({source: 'current_selling_price', price: currentSellingPrice});
  }
  const effective = candidates.length
    ? candidates.reduce((best, item) => (item.price < best.price ? item : best), candidates[0])
    : null;
  const effectiveFinalWithCoupon = effective && couponFactor !== null
    ? round2(effective.price * couponFactor)
    : null;
  const priceStackEvidenceComplete = ordinaryMarketingPrice !== null || ordinaryCoverageConfirmedAbsent;
  let finalPriceStatus = 'price_stack_evidence_incomplete';
  if (effectiveFinalWithCoupon !== null && targetFinalPrice !== null) {
    if (effectiveFinalWithCoupon < targetFinalPrice - 1) finalPriceStatus = 'effective_final_below_target';
    else if (effectiveFinalWithCoupon > targetFinalPrice + 1) finalPriceStatus = 'effective_final_above_target';
    else finalPriceStatus = 'effective_final_matches_target';
  }
  if (!priceStackEvidenceComplete && effectiveFinalWithCoupon !== null && targetFinalPrice !== null) {
    if (effectiveFinalWithCoupon < targetFinalPrice - 1) finalPriceStatus = 'limited_fallback_below_target_price_stack_incomplete';
    else if (effectiveFinalWithCoupon > targetFinalPrice + 1) finalPriceStatus = 'limited_fallback_above_target_price_stack_incomplete';
    else finalPriceStatus = 'limited_fallback_matches_target_price_stack_incomplete';
  }
  return {
    candidates,
    effectiveBasePrice: effective?.price ?? null,
    effectiveBaseSource: effective?.source || '',
    effectiveFinalWithCoupon,
    finalPriceStatus,
    priceStackEvidenceComplete,
    ordinaryMarketingPrice,
    ordinaryCoverageConfirmedAbsent,
    limitedDiscountPrice,
    currentSellingPrice,
  };
}

function classifyOrdinaryEvidence(row, stack) {
  const planActivityId = row.ordinaryPlanActivityId || '';
  const liveCheck = String(row.ordinaryActivity42892LiveCheck || row.ordinaryActivityLiveCheck || '').trim();
  const isPartakeMatches = Number(row.ordinaryActivity42892IsPartakeMatches || row.ordinaryActivityIsPartakeMatches || 0);
  const availableMatches = Number(row.ordinaryActivity42892AvailableMatches || row.ordinaryActivityAvailableMatches || 0);
  if (stack.ordinaryMarketingPrice !== null) {
    return {
      status: 'ordinary_price_evidence_present',
      summary: `已读取普通营销活动价 ${stack.ordinaryMarketingPrice}`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (stack.ordinaryCoverageConfirmedAbsent) {
    return {
      status: 'ordinary_coverage_confirmed_absent',
      summary: '已确认该时间窗口无普通营销活动覆盖；限时折扣可作为兜底基准价候选',
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (isPartakeMatches > 0 || availableMatches > 0) {
    return {
      status: 'checked_specific_activity_match_without_price',
      summary: `计划普通活动 ${planActivityId || '-'} live check 命中商品，但缺普通活动价，不能只看限时折扣价`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  if (liveCheck.includes('no_target_skc')) {
    return {
      status: 'checked_specific_activity_no_match',
      summary: `计划普通活动 ${planActivityId || '-'} live check 未命中目标 SKC；若普通活动确实未覆盖，限时折扣才是兜底候选`,
      planActivityId,
      isPartakeMatches,
      availableMatches,
    };
  }
  return {
    status: 'ordinary_evidence_incomplete',
    summary: '普通营销活动覆盖/价格证据不完整；不能仅凭限时折扣价判断最终成交价偏高',
    planActivityId,
    isPartakeMatches,
    availableMatches,
  };
}

function summarizeAboveTargetActions(doc) {
  const rows = (doc?.rows || []).map(r => {
    const stack = classifyFallbackPriceStack(r);
    const ordinaryEvidence = classifyOrdinaryEvidence(r, stack);
    const limitedFallbackFinalWithCoupon = stack.limitedDiscountPrice !== null && numberOrNull(r.couponFactor) !== null
      ? round2(stack.limitedDiscountPrice * numberOrNull(r.couponFactor))
      : numberOrNull(r.finalWithCoupon);
    const targetFinal = numberOrNull(r.targetFinalPrice);
    const limitedFallbackDiff = limitedFallbackFinalWithCoupon !== null && targetFinal !== null
      ? round2(limitedFallbackFinalWithCoupon - targetFinal)
      : numberOrNull(r.diff);
    const fallbackOnly = stack.effectiveBaseSource === 'limited_discount' || !stack.priceStackEvidenceComplete;
    const suggestedAction = fallbackOnly
      ? '先确认普通营销活动是否覆盖并形成更低可叠券基准价；若未覆盖，才调整限时折扣兜底到 targetBaseNeeded；保留 15% 券，不取消券'
      : '已有更低有效基准价证据时，不得只因限时折扣价偏高而调整限时折扣；先按有效基准价复核最终成交价';
    return {
      storeKey: r.storeKey,
      skc: r.skc,
      canonical: r.canonical,
      priceStackEvidenceComplete: stack.priceStackEvidenceComplete,
      finalPriceStatus: stack.finalPriceStatus,
      effectiveBaseSource: stack.effectiveBaseSource,
      effectiveBasePrice: stack.effectiveBasePrice,
      effectiveFinalWithCoupon: stack.effectiveFinalWithCoupon,
      ordinaryEvidenceStatus: ordinaryEvidence.status,
      ordinaryEvidenceSummary: ordinaryEvidence.summary,
      ordinaryPlanActivityId: ordinaryEvidence.planActivityId,
      ordinaryActivityIsPartakeMatches: ordinaryEvidence.isPartakeMatches,
      ordinaryActivityAvailableMatches: ordinaryEvidence.availableMatches,
      limitedFallbackPrice: stack.limitedDiscountPrice,
      targetBaseNeeded: numberOrNull(r.targetBaseNeeded),
      limitedFallbackFinalWithCoupon,
      targetFinalPrice: targetFinal,
      limitedFallbackDiff,
      legacyFieldMeaning: 'currentBasePrice/finalWithCoupon/diff were removed from this summary because limited-discount fallback is not necessarily the final effective price',
      limitedDiscountEnd: r.limitedDiscountEnd,
      suggestedAction,
      originalSuggestedAction: r.suggestedAction || '',
      executeAutomatically: false,
      reason: `${ordinaryEvidence.summary}；限时折扣价 × 券只能表示“兜底层”是否偏高，不等于最终成交价偏高。`,
    };
  });
  return {
    meaning: 'limited_discount_fallback_high_candidates_not_final_price_above_target',
    count: rows.length,
    legacyFieldMeaning: 'aboveTargetActions are limited-discount fallback candidates, not final transaction-price above-target conclusions',
    incompletePriceStackEvidenceCount: rows.filter(r => !r.priceStackEvidenceComplete).length,
    effectiveFinalAboveTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_above_target').length,
    effectiveFinalMatchesTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_matches_target').length,
    effectiveFinalBelowTargetCount: rows.filter(r => r.priceStackEvidenceComplete && r.finalPriceStatus === 'effective_final_below_target').length,
    limitedFallbackBelowTargetIncompleteCount: rows.filter(r => r.finalPriceStatus === 'limited_fallback_below_target_price_stack_incomplete').length,
    rows,
  };
}

function summarizeBiPortal(doc, source) {
  return {
    generatedAt: doc?.generatedAt || '',
    salesDate: doc?.dates?.salesDate || '',
    linkDate: doc?.dates?.linkDate || '',
    businessDate: doc?.dates?.businessDate || '',
    status: source.status,
    stale: source.status === 'stale',
  };
}

function summarizeT3Candidates(stackDoc, reportDate) {
  const start = parseLocalDateTime(`${reportDate} 00:00:00`);
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  const grouped = new Map();
  for (const row of stackDoc?.detailRows || []) {
    const deadline = parseLocalDateTime(row['报名截止']);
    if (!deadline || deadline < start || deadline > end) continue;
    if (String(row['活动类型'] || '').includes('优惠券')) continue;
    const key = [row['店铺'], row['活动ID']].join('::');
    const item = grouped.get(key) || {
      store: row['店铺'],
      activityId: row['活动ID'],
      activityName: row['活动名称'],
      signupDeadline: row['报名截止'],
      rows: 0,
      missingCostRows: 0,
      missingStorageRows: 0,
      missingOverrideRows: 0,
      canonicalSamples: [],
    };
    item.rows += 1;
    if (!(Number(row['商品完整成本SAR']) > 0)) item.missingCostRows += 1;
    if (!(Number(row['仓储费摊销SAR/件']) > 0)) item.missingStorageRows += 1;
    const combo = String(row['本期组合/券策略'] || row['修改意见/备注'] || '');
    if (!combo && !(Number(row['本次建议普通活动价SAR']) > 0)) item.missingOverrideRows += 1;
    if (item.canonicalSamples.length < 5 && row['标准货号']) item.canonicalSamples.push(row['标准货号']);
    grouped.set(key, item);
  }
  return [...grouped.values()].sort((a, b) => String(a.signupDeadline).localeCompare(String(b.signupDeadline)));
}

function normKey(value) {
  return String(value || '').trim().toUpperCase();
}

function normSku(value) {
  return String(value || '').trim();
}

function planItemKey(row) {
  return `${normKey(row?.storeKey || row?.store || row?.['店铺'])}::${normSku(row?.skc || row?.SKC || row?.['SKC'])}`;
}

function standardKey(storeKey, canonical) {
  return `${normKey(storeKey)}::${normSku(canonical)}`;
}

function collectPlanEvidence(selectionPlanDoc, priceOverridesDoc) {
  const selectedBySkc = new Map();
  const overrideBySkc = new Map();
  const excludedBySkc = new Map();
  const plannedStandardsByStore = new Map();
  const addStandard = row => {
    const storeKey = normKey(row?.storeKey || row?.store || row?.['店铺']);
    const canonical = normSku(row?.canonical || row?.standard_goods_sn || row?.standardGoodsSn || row?.['标准货号']);
    if (!storeKey || !canonical) return;
    const key = standardKey(storeKey, canonical);
    const item = plannedStandardsByStore.get(key) || {
      storeKey,
      canonical,
      plannedSkcSamples: [],
      couponFactors: new Set(),
      finalTargetPriceSamples: [],
      combos: new Set(),
    };
    const skc = normSku(row?.skc || row?.SKC || row?.['SKC']);
    if (skc && item.plannedSkcSamples.length < 5 && !item.plannedSkcSamples.includes(skc)) item.plannedSkcSamples.push(skc);
    const couponFactor = numberOrNull(row?.couponFactor);
    if (couponFactor !== null) item.couponFactors.add(couponFactor);
    const finalTargetPrice = numberOrNull(row?.finalTargetPrice ?? row?.targetPrice);
    if (finalTargetPrice !== null && item.finalTargetPriceSamples.length < 5) item.finalTargetPriceSamples.push(finalTargetPrice);
    const combo = String(row?.combo || row?.rule || '').trim();
    if (combo) item.combos.add(combo);
    plannedStandardsByStore.set(key, item);
  };
  for (const row of selectionPlanDoc?.items || []) {
    const key = planItemKey(row);
    if (!key.endsWith('::')) selectedBySkc.set(key, row);
    addStandard(row);
  }
  for (const row of priceOverridesDoc?.items || []) {
    const key = planItemKey(row);
    if (!key.endsWith('::')) overrideBySkc.set(key, row);
    addStandard(row);
  }
  for (const row of [
    ...(selectionPlanDoc?.excluded || []),
    ...(priceOverridesDoc?.excluded || []),
  ]) {
    const key = planItemKey(row);
    if (!key.endsWith('::') && !excludedBySkc.has(key)) excludedBySkc.set(key, row);
  }
  return {
    selectedBySkc,
    overrideBySkc,
    excludedBySkc,
    plannedStandardsByStore,
  };
}

function summarizeStandardPlanEvidence(item) {
  if (!item) return null;
  return {
    storeKey: item.storeKey,
    canonical: item.canonical,
    plannedSkcSamples: item.plannedSkcSamples,
    couponFactors: [...item.couponFactors].sort((a, b) => a - b),
    finalTargetPriceSamples: item.finalTargetPriceSamples,
    comboSamples: [...item.combos].slice(0, 3),
  };
}

function isFifteenCouponAllowed(row) {
  const couponFactor = numberOrNull(row?.couponFactor);
  const finalTargetPrice = numberOrNull(row?.finalTargetPrice);
  const combo = String(row?.combo || '').toLowerCase();
  const forbidsCoupon = /禁止\s*15|15\s*%\s*券都禁止|15\/30\/50|不叠券|禁报券/.test(combo);
  return Boolean(couponFactor !== null && Math.abs(couponFactor - 0.85) < 0.01 && finalTargetPrice !== null && !forbidsCoupon);
}

function daysBetweenLocalDates(start, end) {
  if (!start || !end) return null;
  const startDate = parseLocalDateTime(String(start).slice(0, 10));
  const endDate = parseLocalDateTime(String(end).slice(0, 10));
  if (!startDate || !endDate) return null;
  return Math.floor((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function inferShelfAgeDays(link, reportDate) {
  const direct = numberOrNull(link?.shelf_age_days ?? link?.shelf_days);
  if (direct !== null) return {value: direct, source: 'shelf_age_days'};
  const fromLinkDate = daysBetweenLocalDates(link?.link_date, reportDate);
  if (fromLinkDate !== null && fromLinkDate >= 0) return {value: fromLinkDate, source: 'link_date'};
  return {value: null, source: 'missing'};
}

function summarizeNewSkcCandidates({biDoc, biSource, selectionPlanDoc, priceOverridesDoc, storesConfigDoc, reportDate}) {
  const links = Array.isArray(biDoc?.storeLinks) ? biDoc.storeLinks : [];
  const enabledStores = new Set();
  const knownStores = new Set();
  for (const store of storesConfigDoc?.stores || []) {
    const storeKey = normKey(store.storeKey);
    if (!storeKey) continue;
    knownStores.add(storeKey);
    if (store.enabled !== false) enabledStores.add(storeKey);
  }
  const plan = collectPlanEvidence(selectionPlanDoc, priceOverridesDoc);
  const ignored = [];
  const rows = [];
  const byDecision = {};
  let onShelfRows = 0;
  let missingExactPlanOnShelf = 0;
  let recentMissingExactPlanOnShelf = 0;
  let unknownAgeMissingExactPlanOnShelf = 0;
  let exactPlannedRows = 0;
  let exactExcludedRows = 0;

  for (const link of links) {
    const storeKey = normKey(link.store_key || link.storeKey || link.store);
    const skc = normSku(link.skc || link.SKC);
    const canonical = normSku(link.standard_goods_sn || link.standardGoodsSn || link.canonical);
    const isOnShelf = link.is_on_shelf === true || /已上架|ON_SHELF/i.test(String(link.shelf_status_name || link.shelf_statuses || ''));
    if (!isOnShelf) continue;
    onShelfRows += 1;
    if (!storeKey || !skc) {
      ignored.push({storeKey, skc, canonical, reason: 'missing_store_or_skc'});
      continue;
    }
    if (!knownStores.has(storeKey)) {
      ignored.push({storeKey, skc, canonical, reason: 'unknown_store'});
      continue;
    }
    if (!enabledStores.has(storeKey)) {
      ignored.push({storeKey, skc, canonical, reason: 'disabled_store'});
      continue;
    }
    const exactKey = `${storeKey}::${skc}`;
    if (plan.selectedBySkc.has(exactKey) || plan.overrideBySkc.has(exactKey)) {
      exactPlannedRows += 1;
      continue;
    }
    missingExactPlanOnShelf += 1;
    const shelfAge = inferShelfAgeDays(link, reportDate);
    const shelfAgeDays = shelfAge.value;
    const isRecent = shelfAgeDays !== null && shelfAgeDays <= NEW_SKC_SHELF_AGE_DAYS;
    const unknownAge = shelfAgeDays === null;
    if (isRecent) recentMissingExactPlanOnShelf += 1;
    if (unknownAge) unknownAgeMissingExactPlanOnShelf += 1;
    if (!isRecent && !unknownAge) continue;

    const exactExcluded = plan.excludedBySkc.get(exactKey) || null;
    if (exactExcluded) exactExcludedRows += 1;
    const sameStandard = canonical ? plan.plannedStandardsByStore.get(standardKey(storeKey, canonical)) : null;
    let decision = 'unplanned_new_on_shelf_skc_needs_pricing';
    let action = '待定价；先补 finalTargetPrice/cost/couponFactor，再决定普通活动、限时折扣兜底和 15% 券';
    if (unknownAge) {
      decision = 'unknown_shelf_age_needs_review';
      action = '缺上架天数且无法用 link_date 兜底；先刷新 BI 链接快照/补年龄证据，再判断是否新链接';
    } else if (exactExcluded) {
      decision = 'known_excluded_needs_pricing';
      action = `已在计划 excluded，原因 ${exactExcluded.reason || 'unknown'}；只能先补价格证据，不能自动报券`;
    } else if (sameStandard) {
      decision = 'same_standard_goods_sn_needs_confirmation';
      action = '同店同标准货号已有计划，但当前 SKC 没有精确计划；需人工确认是否同款同成本/同底价，不得自动继承活动或券策略';
    }
    byDecision[decision] = (byDecision[decision] || 0) + 1;
    const override = plan.overrideBySkc.get(exactKey) || null;
    const couponDryRunEligible = override ? isFifteenCouponAllowed(override) : false;
    rows.push({
      storeKey,
      skc,
      canonical,
      decision,
      action,
      shelfAgeDays,
      shelfAgeSource: shelfAge.source,
      isOnShelf: true,
      linkDate: link.link_date || '',
      c7EpsUv: numberOrNull(link.c7_eps_uv),
      c30EpsUv: numberOrNull(link.c30_eps_uv),
      platformSaleableStock: numberOrNull(link.platform_saleable_stock),
      performanceActivityNames: link.performance_activity_names || '',
      healthBucket: link.health_bucket || '',
      exactPlan: false,
      exactExcludedReason: exactExcluded?.reason || '',
      sameStandardPlan: summarizeStandardPlanEvidence(sameStandard),
      couponDryRunEligible,
      couponDryRunReason: couponDryRunEligible
        ? '已有精确 15% 券价格证据，可进入 dry-run 评估'
        : '缺精确 finalTargetPrice/couponFactor=0.85/allowed15 证据，不能生成 15% 券 dry-run 建议',
    });
  }
  rows.sort((a, b) => {
    const av = Number(a.c7EpsUv || 0);
    const bv = Number(b.c7EpsUv || 0);
    if (bv !== av) return bv - av;
    return String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc));
  });
  const stale = biSource?.status === 'stale';
  return {
    status: stale ? 'stale_observation_only' : 'ok',
    source: biSource?.path || '',
    sourceGeneratedAt: biDoc?.generatedAt || '',
    linkDate: biDoc?.dates?.linkDate || '',
    recentWindowDays: NEW_SKC_SHELF_AGE_DAYS,
    storeLinksRows: links.length,
    onShelfRows,
    exactPlannedRows,
    missingExactPlanOnShelf,
    recentMissingExactPlanOnShelf,
    unknownAgeMissingExactPlanOnShelf,
    ignoredCount: ignored.length,
    ignored: ignored.slice(0, 30),
    exactExcludedRows,
    needsPricing: rows.filter(r => r.decision === 'unplanned_new_on_shelf_skc_needs_pricing' || r.decision === 'known_excluded_needs_pricing').length,
    needsConfirmation: rows.filter(r => r.decision === 'same_standard_goods_sn_needs_confirmation').length,
    needsAgeReview: rows.filter(r => r.decision === 'unknown_shelf_age_needs_review').length,
    needsCouponReview: rows.filter(r => r.couponDryRunEligible).length,
    byDecision,
    rows: rows.slice(0, NEW_SKC_MAX_ROWS),
  };
}

function latestOrderAuditSelection() {
  const dir = path.join(ROOT, 'tmp', 'marketing-signup', 'order-price-audit');
  const selected = new Map();
  const ignoredNoWindowFiles = [];
  for (const file of listFiles(dir, /^order-price-audit-.*\.json$/)) {
    let doc = null;
    try {
      doc = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const stores = Array.isArray(doc?.summary?.stores) && doc.summary.stores.length
      ? doc.summary.stores
      : [path.basename(file).split('-').slice(3, 4).join('') || path.basename(file)];
    const hasWindow = Boolean(doc?.summary?.planStartTime && doc?.summary?.planEndTime);
    if (!hasWindow) {
      ignoredNoWindowFiles.push({
        path: rel(file),
        stores,
        reason: 'missing planStartTime/planEndTime',
      });
      continue;
    }
    for (const store of stores) {
      if (!selected.has(store)) {
        selected.set(store, {file, hasWindow, store});
      }
    }
  }
  const selectedFiles = [...new Set([...selected.values()].map(x => x.file))].slice(0, 10);
  return {selectedFiles, ignoredNoWindowFiles: ignoredNoWindowFiles.slice(0, 50)};
}

function loadPreviousGuardReport(reportDate) {
  const dir = DEFAULT_OUT_DIR;
  const files = listFiles(dir, /^marketing-daily-guard-\d{4}-\d{2}-\d{2}\.json$/)
    .filter(f => !f.endsWith(`marketing-daily-guard-${reportDate}.json`));
  if (!files.length) return null;
  try {
    return JSON.parse(fsSync.readFileSync(files[0], 'utf8'));
  } catch {
    return null;
  }
}

function buildChangesSincePrevious(current, previous) {
  if (!previous) return [];
  const changes = [];
  const pairs = [
    ['lowPriceOverlap.belowTarget', current.lowPriceOverlap?.belowTarget, previous.lowPriceOverlap?.belowTarget],
    ['lowPriceOverlap.missingEvidence', current.lowPriceOverlap?.missingEvidence, previous.lowPriceOverlap?.missingEvidence],
    ['aboveTargetActions.count', current.aboveTargetActions?.count, previous.aboveTargetActions?.count],
    ['newSkcCandidates.recentMissingExactPlanOnShelf', current.newSkcCandidates?.recentMissingExactPlanOnShelf, previous.newSkcCandidates?.recentMissingExactPlanOnShelf],
    ['newSkcCandidates.unknownAgeMissingExactPlanOnShelf', current.newSkcCandidates?.unknownAgeMissingExactPlanOnShelf, previous.newSkcCandidates?.unknownAgeMissingExactPlanOnShelf],
    ['newSkcCandidates.needsPricing', current.newSkcCandidates?.needsPricing, previous.newSkcCandidates?.needsPricing],
    ['newSkcCandidates.needsConfirmation', current.newSkcCandidates?.needsConfirmation, previous.newSkcCandidates?.needsConfirmation],
    ['newSkcCandidates.needsAgeReview', current.newSkcCandidates?.needsAgeReview, previous.newSkcCandidates?.needsAgeReview],
    ['oldOrdinaryOverlap.cancelRows', current.oldOrdinaryOverlap?.cancelRows, previous.oldOrdinaryOverlap?.cancelRows],
    ['knownOrdinaryActivityGuard.belowTargetCount', current.knownOrdinaryActivityGuard?.belowTargetCount, previous.knownOrdinaryActivityGuard?.belowTargetCount],
    ['knownOrdinaryActivityGuard.evidenceIncompleteCount', current.knownOrdinaryActivityGuard?.evidenceIncompleteCount, previous.knownOrdinaryActivityGuard?.evidenceIncompleteCount],
    ['t3MarketingCandidates.count', current.t3MarketingCandidates?.length, previous.t3MarketingCandidates?.length],
  ];
  for (const [field, now, before] of pairs) {
    if (now !== before) changes.push({field, previous: before, current: now});
  }
  return changes;
}

function validateSuggestedCommand(command) {
  const c = String(command || '');
  const violations = [];
  if (/\s--execute(?:\s|$)/.test(c)) violations.push('contains --execute');
  if (/submit_coupon_activity_goods\.mjs/.test(c) && !/--dry-run|--no-submit/.test(c)) {
    violations.push('submit_coupon_activity_goods.mjs must include --dry-run or --no-submit');
  }
  if (/--discount-max\s+(30|50)\b/.test(c)) violations.push('contains forbidden --discount-max 30/50');
  if (/(cancel_coupon_extra_goods|set_coupon_site_budget|end_limited_discounts_for_coupon_plan|apply_hl_limited_discount_rescue)\.mjs/.test(c)) {
    violations.push('write-capable script is not allowed as a suggested command');
  }
  return violations;
}

function buildDryRunCommands(reportDate) {
  if (reportDate < '2026-06-09') return [];
  const storesConfig = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  const stores = (storesConfig.stores || []).filter(s => s.enabled !== false).map(s => s.storeKey).join(',');
  return [{
    label: 'post-holiday-15pct-coupon-dry-run',
    command: `node scripts/marketing/submit_coupon_activity_goods.mjs --stores ${stores} --target-plan ${rel(TARGET_PLAN_DEFAULT)} --price-overrides ${rel(PRICE_OVERRIDES_DEFAULT)} --dry-run`,
  }];
}

function addBlocker(blockers, code, message, evidence = {}) {
  blockers.push({code, message, evidence});
}

function humanCount(value, unit = '个') {
  const n = Number(value || 0);
  return `${n} ${unit}`;
}

function humanSourceWarningText(warning) {
  const labelMap = {
    marketingStackReview: '营销审核表',
    couponSubmitLatestSummary: '优惠券提交结果',
    lowPriceOverlapLive: '限时折扣叠券扫描',
    lowPriceOverlapCancelList: '限时折扣叠券取消清单',
    oldOrdinaryOverlapLive: '旧普通活动叠券扫描',
    oldOrdinaryOverlapCancelList: '旧普通活动叠券取消清单',
    targetSelectionPlan: '活动报名计划',
    priceOverridesPlan: '目标价计划',
    storesConfig: '店铺配置',
    knownOrdinaryActivityEvidence: '旧普通活动填报价证据',
  };
  const label = labelMap[warning?.label] || warning?.label || '数据源';
  if (warning?.code === 'source_stale') {
    const hours = Number(warning?.evidence?.dataAgeHours ?? warning?.evidence?.artifactAgeHours);
    const ageText = Number.isFinite(hours) ? `，大约 ${Math.round(hours)} 小时未刷新` : '';
    return `${label}不是最新${ageText}；今天不阻塞价格止损结论，但后续报名/补券前要刷新。`;
  }
  return String(warning?.message || `${label}需要留意。`).replace(String(warning?.label || ''), label);
}

function storeCountText(counts = {}, limit = 8) {
  const entries = Object.entries(counts || {}).filter(([, v]) => Number(v) > 0).sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) return '';
  const shown = entries.slice(0, limit).map(([store, count]) => `${store} ${count}`).join('、');
  return entries.length > limit ? `${shown} 等 ${entries.length} 店` : shown;
}

function humanBlockerText(blocker) {
  const code = String(blocker?.code || '');
  const msg = String(blocker?.message || '').trim();
  const map = {
    coupon_final_below_target: '有商品叠券后低于目标价，先止损，不能自动继续报名。',
    coupon_missing_price_evidence: '有商品缺少价格证据，系统先自动回读价格；取不到才报告具体阻塞。',
    low_price_cancel_rows_nonzero: '有低价/限时折扣叠券取消候选，先确认并取消错误优惠券。',
    old_ordinary_cancel_rows_nonzero: '有旧普通活动和优惠券叠加风险，先按目标价复核。',
    known_ordinary_coupon_final_below_target: '有旧普通活动价叠加 15% 券后低于目标价，应取消对应 15% 券。',
    known_ordinary_missing_final_target_price: '有旧普通活动重叠但缺目标价，系统先回查计划价/覆盖价；取不到才报告具体阻塞。',
    known_ordinary_evidence_incomplete: '有旧普通活动标签但缺实际填报价，系统必须自动只读查价；取不到才报告登录/接口/身份阻塞。',
    coupon_budget_below_target: '有店铺优惠券预算低于 1000 SAR，需要补预算。',
    coupon_budget_missing_evidence: '有店铺缺优惠券预算回读证据，不能确认预算安全。',
    store_identity_failure: '店铺登录身份不匹配，必须先修账号/profile。',
    source_stale: '关键数据过期，先刷新数据再判断。',
    critical_source_missing: '关键数据缺失，不能形成安全结论。',
    source_parse_error: '关键数据解析失败，先修数据源。',
    marketing_stack_review_incomplete_store_coverage: '营销审核没有覆盖所有启用店铺，不能当作全局安全。',
    unsafe_suggested_command: '自动建议命令不安全，禁止执行。',
  };
  return map[code] || msg || '存在未归类阻塞项，需要先人工复核。';
}

function buildHumanSummary(report) {
  const actions = [];
  const watches = [];
  const ok = [];
  const guard = report.knownOrdinaryActivityGuard || {};
  const low = report.lowPriceOverlap || {};
  const old = report.oldOrdinaryOverlap || {};
  const above = report.aboveTargetActions || {};
  const newSkc = report.newSkcCandidates || {};
  const budget = report.couponBudget || {};
  const orders = report.orderPriceAudit || {};

  for (const blocker of report.blockers || []) {
    actions.push({level: '必须处理', text: humanBlockerText(blocker)});
  }
  if (Number(guard.mitigatedBelowTargetCount || 0) > 0) {
    const stores = storeCountText(guard.mitigatedByStore || {});
    ok.push(`已确认并处理过 ${humanCount(guard.mitigatedBelowTargetCount, '个')}旧普通活动叠券低价风险${stores ? `（${stores}）` : ''}，当前不再阻塞。`);
  }
  if (Number(guard.belowTargetCount || 0) === 0 && Number(guard.evidenceIncompleteCount || 0) === 0 && Number(guard.missingFinalTargetPriceCount || 0) === 0) {
    ok.push('旧普通活动 + 15% 券：当前没有未处理的低价或待取证风险。');
  }
  if (Number(low.belowTarget || 0) === 0 && Number(low.missingEvidence || 0) === 0 && Number(low.cancelRows || 0) === 0) {
    ok.push('限时折扣兜底层：当前没有需要取消优惠券的低价叠加风险。');
  }
  if (!old.riskCancel && Number(old.cancelRows || 0) === 0) {
    ok.push('旧普通活动 live 扫描：当前没有新的取消候选。');
  }
  if (Number(above.effectiveFinalBelowTargetCount || 0) > 0 || Number(above.limitedFallbackBelowTargetIncompleteCount || 0) > 0) {
    actions.push({level: '必须处理', text: '有效价格栈或限时折扣兜底层显示可能低于目标价，系统先只读补齐普通活动证据，再决定取消或改折扣。'});
  } else if (Number(above.count || 0) > 0) {
    watches.push(`有 ${humanCount(above.count, '个')}限时折扣兜底偏高/证据观察项；这不等于最终成交价偏高，只作为后续补救线索。`);
  }
  if (Number(newSkc.needsPricing || 0) > 0 || Number(newSkc.needsConfirmation || 0) > 0 || Number(newSkc.needsCouponReview || 0) > 0) {
    watches.push(`有新链接/新 SKC 需要定价或确认，先生成动作卡，不自动报名。`);
  } else if (Number(newSkc.recentMissingExactPlanOnShelf || 0) === 0) {
    ok.push('新上架链接：当前没有 30 天内上架且缺精确价格计划的候选。');
  }
  if (Array.isArray(report.t3MarketingCandidates) && report.t3MarketingCandidates.length) {
    watches.push(`未来 3 天内有 ${humanCount(report.t3MarketingCandidates.length, '个')}普通营销活动报名提醒；只提醒，不自动填报。`);
  } else {
    ok.push('未来 3 天普通营销活动：暂无需要提醒的报名候选。');
  }
  if (Number(budget.belowTargetCount || 0) > 0) {
    actions.push({level: '必须处理', text: `有 ${humanCount(budget.belowTargetCount, '个')}店铺优惠券预算低于 1000 SAR，需要补预算。`});
  } else if (Number(budget.missingEvidenceCount || 0) > 0) {
    actions.push({level: '必须处理', text: `有 ${humanCount(budget.missingEvidenceCount, '个')}店铺缺预算回读证据，先回读确认。`});
  } else if (Number(budget.expectedStoreCount || 0) > 0) {
    ok.push('优惠券预算：当前没有低于 1000 SAR 的店铺。');
  }
  if (Number(orders.below || 0) > 0 || Number(orders.above || 0) > 0) {
    watches.push(`订单成交价审计发现 ${humanCount(Number(orders.below || 0) + Number(orders.above || 0), '条')}偏离线索；只按商品行成交价判断，不看页面汇总金额。`);
  }
  if (report.reportDate < '2026-06-09') {
    watches.push('度假季/旧低价活动后补券还没到复扫窗口，今天不生成补券 dry-run。');
  } else if (Array.isArray(report.suggestedDryRunCommands) && report.suggestedDryRunCommands.length) {
    watches.push('已到补券复扫窗口，只生成 15% 券 dry-run；禁止 30%/50% 券真实上线。');
  }
  if (Array.isArray(report.sourceWarnings) && report.sourceWarnings.length) {
    watches.push(`有 ${humanCount(report.sourceWarnings.length, '条')}数据源提醒，不阻塞价格结论，但需要留意。`);
  }
  if (Array.isArray(report.unknownSources) && report.unknownSources.length) {
    actions.push({level: '必须处理', text: '有关键数据源不可用，不能自动执行。'});
  }

  const canAutoExecute = actions.length === 0 && (report.blockers || []).length === 0;
  const conclusion = canAutoExecute
    ? (watches.length ? '没有需要立即止损的风险；有少量观察/提醒项，暂不需要写入动作。' : '没有需要动作的风险，今天保持巡检即可。')
    : `不能自动执行；先处理 ${humanCount(actions.length, '类')}问题。`;
  const autoExecution = canAutoExecute
    ? '当前日报仍是只读模式；将来要自动执行时，只能执行已经有明确证据、明确动作、可回读验证的低风险动作。'
    : '当前不允许自动写入；系统必须先自动取证或止损。';
  return {conclusion, autoExecution, actions, watches, ok: ok.slice(0, 8)};
}

function buildMarkdown(report) {
  const summary = report.humanSummary || buildHumanSummary(report);
  const lines = [];
  lines.push(`# SHEIN 营销每日巡检 ${report.reportDate}`);
  lines.push('');
  lines.push('## 先看结论');
  lines.push('');
  lines.push(`- ${summary.conclusion}`);
  lines.push(`- ${summary.autoExecution}`);
  lines.push('- 本报告只读；没有真实提交、取消、补预算或改限时折扣。');
  lines.push('');
  lines.push('## 需要做什么');
  lines.push('');
  if (!summary.actions.length) {
    lines.push('- 现在不用做止损动作。');
  } else {
    for (const item of summary.actions.slice(0, 12)) lines.push(`- ${item.level}：${item.text}`);
  }
  lines.push('');
  lines.push('## 需要留意');
  lines.push('');
  if (!summary.watches.length) {
    lines.push('- 暂无需要额外留意的观察项。');
  } else {
    for (const text of summary.watches.slice(0, 12)) lines.push(`- ${text}`);
  }
  lines.push('');
  lines.push('## 已确认安全/已处理');
  lines.push('');
  if (!summary.ok.length) {
    lines.push('- 暂无额外安全项。');
  } else {
    for (const text of summary.ok.slice(0, 12)) lines.push(`- ${text}`);
  }
  lines.push('');
  lines.push('## 今日关键状态');
  lines.push('');
  lines.push(`- 价格止损阻塞：${report.blockers.length ? `${humanCount(report.blockers.length, '个')}，不能自动执行` : '无'}`);
  lines.push(`- 旧普通活动叠券：未处理低价 ${humanCount(report.knownOrdinaryActivityGuard.belowTargetCount, '个')}；待系统只读查价 ${humanCount(report.knownOrdinaryActivityGuard.evidenceIncompleteCount, '个')}；已取消止损 ${humanCount(report.knownOrdinaryActivityGuard.mitigatedBelowTargetCount || 0, '个')}`);
  lines.push(`- 限时折扣叠券：低价 ${humanCount(report.lowPriceOverlap.belowTarget, '个')}；待系统补价证据 ${humanCount(report.lowPriceOverlap.missingEvidence, '个')}；取消候选 ${humanCount(report.lowPriceOverlap.cancelRows, '个')}`);
  lines.push(`- 优惠券预算：低于 1000 SAR 的店铺 ${humanCount(report.couponBudget.belowTargetCount, '个')}；缺回读证据 ${humanCount(report.couponBudget.missingEvidenceCount, '个')}`);
  lines.push(`- 新链接/新 SKC：需要定价 ${humanCount(report.newSkcCandidates.needsPricing, '个')}；需要确认 ${humanCount(report.newSkcCandidates.needsConfirmation, '个')}；需要补券复核 ${humanCount(report.newSkcCandidates.needsCouponReview, '个')}`);
  lines.push(`- 未来 3 天普通活动提醒：${humanCount(report.t3MarketingCandidates.length, '个')}`);
  lines.push('');
  lines.push('## 证据文件');
  lines.push('');
  lines.push(`- 机器完整报告：\`outputs/reports/marketing-daily-guard-${report.reportDate}.json\``);
  lines.push(`- 人话版报告：\`outputs/reports/marketing-daily-guard-${report.reportDate}.md\``);
  if (report.knownOrdinaryActivityGuard.cancelMitigation?.verificationPath) {
    lines.push(`- 已取消止损验证：\`${report.knownOrdinaryActivityGuard.cancelMitigation.verificationPath}\``);
  }
  if (report.biPortalSourceSelection?.selectedPath) {
    lines.push(`- BI 数据源：\`${report.biPortalSourceSelection.selectedPath}\``);
  }
  if (report.sourceWarnings.length) {
    lines.push('');
    lines.push('## 数据源提醒');
    lines.push('');
    for (const w of report.sourceWarnings.slice(0, 8)) lines.push(`- ${humanSourceWarningText(w)}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('技术字段、完整明细、脚本命令只保存在 JSON 中；Markdown 默认不展开大表，避免误读。');
  lines.push('');
  return lines.join('\n');
}
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const sources = [];
  const read = async (label, file) => {
    const item = await readSource(label, file, now, args.maxAgeHours);
    sources.push(item.source);
    return item;
  };

  const biPortalSelection = await selectSharedBiPortalSource({
    root: ROOT,
    biPortalData: args.biPortalData,
    cloudBiSsh: args.cloudBiSsh,
    cloudBiRoot: args.cloudBiRoot,
    cloudBiSshTimeoutMs: args.cloudBiSshTimeoutMs,
    cloudBiMaxBytes: args.cloudBiMaxBytes,
    now,
    maxAgeHours: args.maxAgeHours,
  });
  const biPortal = biPortalSelection.selected;
  sources.push(biPortal.source);
  const targetPlan = await read('targetSelectionPlan', args.targetPlan);
  const priceOverrides = await read('priceOverridesPlan', args.priceOverrides);
  const storesConfig = await read('storesConfig', args.storesConfig);
  const couponSubmitPath = latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-submit-results'), /^summary-.*\.json$/);
  const couponSubmit = await read('couponSubmitLatestSummary', couponSubmitPath);
  const lowLive = await read('lowPriceOverlapLive', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^coupon-low-price-overlap-live-.*\.json$/));
  const lowCancel = await read('lowPriceOverlapCancelList', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^coupon-low-price-overlap-cancel-list-.*\.json$/));
  const oldLive = await read('oldOrdinaryOverlapLive', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'old-ordinary-overlap-risk'), /^coupon-old-ordinary-overlap-live-.*\.json$/));
  const oldCancel = await read('oldOrdinaryOverlapCancelList', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'old-ordinary-overlap-risk'), /^coupon-old-ordinary-overlap-cancel-list-.*\.json$/));
  const abovePlan = await read('aboveTargetActionPlan', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'low-price-overlap-risk'), /^price-above-target-limited-discount-action-plan-.*\.json$/));
  const budgetExecute = await read('couponBudgetExecute', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results'), /^coupon-site-budget-execute-.*\.json$/));
  const budgetDryRun = await read('couponBudgetDryRun', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results'), /^coupon-site-budget-dry-run-.*\.json$/));
  const stackReview = await read('marketingStackReview', latestFile(path.join(ROOT, 'outputs', 'reports'), /^marketing-stack-review-\d{4}-\d{2}-\d{2}\.json$/));
  const marketingStackReviewContext = normalizeMarketingStackReviewSource(stackReview, now, args.maxAgeHours);
  const knownOrdinaryEvidenceDir = path.join(ROOT, 'tmp', 'mbrs', 'deadline-fill-results');
  const knownOrdinaryEvidenceSource = {
    label: 'knownOrdinaryActivityEvidence',
    path: rel(knownOrdinaryEvidenceDir),
    exists: fsSync.existsSync(knownOrdinaryEvidenceDir),
    mtime: '',
    generatedAt: '',
    createdAt: '',
    ageHours: null,
    artifactAgeHours: null,
    dataAgeHours: null,
    status: fsSync.existsSync(knownOrdinaryEvidenceDir) ? 'ok' : 'missing',
  };
  if (knownOrdinaryEvidenceSource.exists) {
    const files = listFiles(knownOrdinaryEvidenceDir, /\.json$/);
    knownOrdinaryEvidenceSource.fileCount = files.length;
    const latest = files[0] || '';
    if (latest) {
      const stat = fsSync.statSync(latest);
      knownOrdinaryEvidenceSource.latestFile = rel(latest);
      knownOrdinaryEvidenceSource.mtime = stat.mtime.toISOString();
      knownOrdinaryEvidenceSource.artifactAgeHours = ageHours(now, stat.mtime);
    }
  }
  sources.push(knownOrdinaryEvidenceSource);
  let couponEligibilityPlan = null;
  let couponEligibilityPlanError = '';
  try {
    couponEligibilityPlan = await loadCouponTargetEligibilityPlan({
      root: ROOT,
      planPath: args.targetPlan,
      priceOverridesPaths: [args.priceOverrides],
      targetDiscountPct: 15,
    });
  } catch (err) {
    couponEligibilityPlanError = err.message;
  }
  const ordinaryEvidenceByStore = new Map();
  if (couponEligibilityPlan && knownOrdinaryEvidenceSource.exists) {
    const evidenceStoreKeys = [...new Set([
      ...mapKeys(couponEligibilityPlan.rowsByStore),
      ...mapKeys(couponEligibilityPlan.allowed15ByStore || couponEligibilityPlan.byStore),
    ])].sort();
    for (const storeKey of evidenceStoreKeys) {
      const evidence = await loadKnownOrdinaryPriceEvidence({root: ROOT, storeKey});
      ordinaryEvidenceByStore.set(storeKey, {
        ...evidence,
        bySkc: groupOrdinaryEvidenceBySkc(evidence.rows),
      });
    }
    knownOrdinaryEvidenceSource.storeCount = evidenceStoreKeys.length;
    knownOrdinaryEvidenceSource.rowCount = [...ordinaryEvidenceByStore.values()].reduce((n, e) => n + Number(e.rows?.length || 0), 0);
    knownOrdinaryEvidenceSource.parseErrorCount = [...ordinaryEvidenceByStore.values()].reduce((n, e) => n + Number(e.parseErrorCount || 0), 0);
    if (knownOrdinaryEvidenceSource.parseErrorCount > 0) knownOrdinaryEvidenceSource.status = 'parse_error';
  }
  const knownOrdinaryCancelMitigation = await loadKnownOrdinaryCancelMitigation(args.date);

  const orderAuditSelection = latestOrderAuditSelection();
  const orderFiles = orderAuditSelection.selectedFiles;
  const orderDocs = [];
  for (const file of orderFiles) {
    const item = await read(`orderPriceAudit:${path.basename(file)}`, file);
    if (item.data) orderDocs.push(item.data);
  }

  const couponSubmitDryRun = summarizeCouponSubmit(couponSubmit.data);
  couponSubmitDryRun.summaryPath = rel(couponSubmitPath);

  const lowPriceOverlap = summarizeLowPriceOverlap(lowLive.data, lowCancel.data);
  const oldOrdinaryOverlap = summarizeOldOrdinaryOverlap(oldLive.data, oldCancel.data);
  const knownOrdinaryActivityGuard = summarizeKnownOrdinaryActivityGuard({
    couponPlan: couponEligibilityPlan,
    ordinaryEvidenceByStore,
    stackDoc: stackReview.data,
    cancelMitigation: knownOrdinaryCancelMitigation,
  });
  const aboveTargetActions = summarizeAboveTargetActions(abovePlan.data);
  const orderPriceAudit = countOrderStatuses(orderDocs);
  const biPortalFreshness = summarizeBiPortal(biPortal.data, biPortal.source);
  const t3MarketingCandidates = summarizeT3Candidates(stackReview.data, args.date);
  const marketingStackReviewCoverage = summarizeStackReviewCoverage(stackReview.data, storesConfig.data);
  const couponBudget = summarizeCouponBudgetStatus({
    executeDoc: budgetExecute.data,
    executeSource: budgetExecute.source,
    dryRunDoc: budgetDryRun.data,
    dryRunSource: budgetDryRun.source,
    storesConfigDoc: storesConfig.data,
    targetBudget: 1000,
  });
  const newSkcCandidates = summarizeNewSkcCandidates({
    biDoc: biPortal.data,
    biSource: biPortal.source,
    selectionPlanDoc: targetPlan.data,
    priceOverridesDoc: priceOverrides.data,
    storesConfigDoc: storesConfig.data,
    reportDate: args.date,
  });
  const suggestedDryRunCommands = buildDryRunCommands(args.date);
  const blockers = [];
  const sourceWarnings = [];
  const contextWarnings = [];
  const unknownSources = [];

  const safety = {
    readOnly: true,
    liveScan: false,
    writeActions: false,
    dryRunCommandsOnly: true,
    blockedExecuteCommands: ['--execute', '--discount-max 30', '--discount-max 50'],
  };

  if (marketingStackReviewContext?.biContextStale && biPortalFreshness.status === 'ok') {
    contextWarnings.push({
      code: 'marketing_stack_bi_context_stale',
      label: 'marketingStackReview',
      message: '营销叠加审核表的活动扫描本身按 createdAt 判断；其 BI 标签/链接上下文来自旧本地 BI，不作为新鲜 BI 证据',
      evidence: {
        biContextGeneratedAt: marketingStackReviewContext.biContextGeneratedAt,
        biContextAgeHours: marketingStackReviewContext.biContextAgeHours,
        selectedBiPortalGeneratedAt: biPortalFreshness.generatedAt,
      },
    });
  }

  for (const diagnostic of biPortalSelection.diagnostics || []) {
    if (diagnostic.type === 'cloud_fetch_failed_local_fresh' || diagnostic.type === 'cloud_fetch_failed_local_not_fresh') {
      sourceWarnings.push({
        code: 'cloud_bi_fetch_failed',
        label: 'biPortalData',
        message: `云端 BI 快照读取失败，已${diagnostic.type === 'cloud_fetch_failed_local_fresh' ? '使用本地新鲜快照兜底' : '使用本地非新鲜/缺失快照兜底'}；不能把云端不可达静默当作无风险`,
        evidence: {
          path: diagnostic.source?.path || '',
          status: diagnostic.source?.status || '',
          error: diagnostic.source?.error || '',
        },
      });
    } else if (diagnostic.type === 'cloud_selected_not_fresh') {
      sourceWarnings.push({
        code: 'cloud_bi_source_stale',
        label: 'biPortalData',
        message: '云端 BI 快照可读但超过新鲜度阈值，不能形成 no-action 结论',
        evidence: {
          path: diagnostic.source?.path || '',
          dataAgeHours: diagnostic.source?.dataAgeHours ?? null,
        },
      });
    }
  }

  for (const src of sources) {
    const optionalBudgetDryRunCoveredByExecute = src.label === 'couponBudgetDryRun'
      && couponBudget.selectedSource === 'execute';
    if (optionalBudgetDryRunCoveredByExecute && ['missing', 'parse_error', 'stale'].includes(src.status)) {
      continue;
    }
    if (src.status === 'missing' && CRITICAL_SOURCE_LABELS.has(src.label)) {
      addBlocker(blockers, 'critical_source_missing', `${src.label} 缺失，不能生成 no-action 结论`, {path: src.path});
      unknownSources.push({label: src.label, path: src.path, status: src.status});
    }
    if (src.status === 'parse_error') {
      addBlocker(blockers, 'source_parse_error', `${src.label} 解析失败`, {path: src.path, error: src.error});
      if (CRITICAL_SOURCE_LABELS.has(src.label)) unknownSources.push({label: src.label, path: src.path, status: src.status});
    }
    if (src.status === 'stale' && STALE_BLOCKER_SOURCE_LABELS.has(src.label)) {
      addBlocker(blockers, 'source_stale', `${src.label} 已超过 ${args.maxAgeHours} 小时`, {path: src.path, artifactAgeHours: src.artifactAgeHours, dataAgeHours: src.dataAgeHours});
    } else if (src.status === 'stale') {
      sourceWarnings.push({
        code: 'source_stale',
        label: src.label,
        message: `${src.label} 已超过 ${args.maxAgeHours} 小时，不能作为 no-action 的完整新鲜证据`,
        evidence: {path: src.path, artifactAgeHours: src.artifactAgeHours, dataAgeHours: src.dataAgeHours},
      });
    }
  }
  if (couponSubmitDryRun.status === 'untrusted') addBlocker(blockers, 'coupon_submit_not_dry_run', '最新优惠券提交 summary 不是 dry-run，不能作为自动任务安全证据', {path: couponSubmitDryRun.summaryPath});
  if (couponEligibilityPlanError) addBlocker(blockers, 'coupon_target_plan_classifier_failed', '优惠券 allowed15 目标计划解析失败，不能判断旧普通活动叠券风险', {error: couponEligibilityPlanError});
  if (knownOrdinaryEvidenceSource.status === 'missing') addBlocker(blockers, 'known_ordinary_evidence_missing', '旧普通营销活动填报价证据目录缺失，不能形成价格栈 no-action 结论', {path: knownOrdinaryEvidenceSource.path});
  if (!biPortal.data) addBlocker(blockers, 'bi_portal_source_unavailable', '没有可解析的 BI Portal data.json，不能判断新链接、BI 标签或新鲜度', {path: biPortal.source?.path || ''});
  if (!marketingStackReviewCoverage.coverageComplete) {
    addBlocker(
      blockers,
      'marketing_stack_review_incomplete_store_coverage',
      '营销叠加审核表没有完整显式覆盖所有启用店铺，不能作为完整 T-3/普通活动候选证据',
      {
        selectedStoreCount: marketingStackReviewCoverage.selectedStoreCount,
        enabledStoreCount: marketingStackReviewCoverage.enabledStoreCount,
        storeStatusCount: marketingStackReviewCoverage.storeStatusCount,
        completedStoreCount: marketingStackReviewCoverage.completedStoreCount,
        missingStores: marketingStackReviewCoverage.missingStores,
        issues: marketingStackReviewCoverage.issues,
      },
    );
  }
  for (const f of couponSubmitDryRun.identityFailures || []) addBlocker(blockers, 'store_identity_failure', `${f.store} 身份校验失败`, f);
  if (lowPriceOverlap.belowTarget > 0) addBlocker(blockers, 'coupon_final_below_target', `低价叠券 below target=${lowPriceOverlap.belowTarget}`);
  if (lowPriceOverlap.missingEvidence > 0) addBlocker(blockers, 'coupon_missing_price_evidence', `低价叠券缺价格证据=${lowPriceOverlap.missingEvidence}`);
  if (lowPriceOverlap.cancelRows > 0) addBlocker(blockers, 'low_price_cancel_rows_nonzero', `低价叠券取消候选 rows=${lowPriceOverlap.cancelRows}`);
  if (oldOrdinaryOverlap.riskCancel || oldOrdinaryOverlap.cancelRows > 0) addBlocker(blockers, 'old_ordinary_cancel_rows_nonzero', `旧普通活动 cancel rows=${oldOrdinaryOverlap.cancelRows}`);
  if (knownOrdinaryActivityGuard.belowTargetCount > 0) {
    addBlocker(
      blockers,
      'known_ordinary_coupon_final_below_target',
      `已知旧普通活动价叠加15%券低于目标=${knownOrdinaryActivityGuard.belowTargetCount}`,
      {samples: knownOrdinaryActivityGuard.belowTargetRows.slice(0, 20)},
    );
  }
  if (knownOrdinaryActivityGuard.missingFinalTargetPriceCount > 0) {
    addBlocker(
      blockers,
      'known_ordinary_missing_final_target_price',
      `已知旧普通活动重叠但缺 finalTargetPrice=${knownOrdinaryActivityGuard.missingFinalTargetPriceCount}`,
      {samples: knownOrdinaryActivityGuard.missingFinalTargetPriceRows.slice(0, 20)},
    );
  }
  if (knownOrdinaryActivityGuard.evidenceIncompleteCount > 0) {
    addBlocker(
      blockers,
      'known_ordinary_evidence_incomplete',
      `15%券计划商品存在旧普通活动标签但缺填报价证据=${knownOrdinaryActivityGuard.evidenceIncompleteCount}`,
      {samples: knownOrdinaryActivityGuard.evidenceIncompleteRows.slice(0, 20)},
    );
  }
  if (aboveTargetActions.effectiveFinalBelowTargetCount > 0) {
    addBlocker(blockers, 'effective_final_below_target_from_price_stack', `有效价格栈券后低于目标=${aboveTargetActions.effectiveFinalBelowTargetCount}`);
  }
  if (aboveTargetActions.limitedFallbackBelowTargetIncompleteCount > 0) {
    addBlocker(blockers, 'limited_fallback_below_target_price_stack_incomplete', `限时折扣兜底层券后低于目标但价格栈证据不完整=${aboveTargetActions.limitedFallbackBelowTargetIncompleteCount}`);
  }
  if (newSkcCandidates.ignoredCount > 0) {
    sourceWarnings.push({
      code: 'new_skc_ignored_store_rows',
      label: 'newSkcCandidates',
      message: `BI storeLinks 有 ${newSkcCandidates.ignoredCount} 行因 unknown/disabled/missing store 或缺 SKC 被忽略，不能作为可执行候选`,
      evidence: {samples: newSkcCandidates.ignored.slice(0, 10)},
    });
  }
  if (newSkcCandidates.unknownAgeMissingExactPlanOnShelf > 0) {
    sourceWarnings.push({
      code: 'new_skc_unknown_shelf_age',
      label: 'newSkcCandidates',
      message: `${newSkcCandidates.unknownAgeMissingExactPlanOnShelf} 个上架且缺精确计划的 SKC 缺上架天数/link_date 证据，不能判定是否新链接`,
      evidence: {samples: newSkcCandidates.rows.filter(r => r.decision === 'unknown_shelf_age_needs_review').slice(0, 10)},
    });
  }
  if (couponBudget.belowTargetCount > 0) {
    addBlocker(
      blockers,
      'coupon_budget_below_target',
      `${couponBudget.belowTargetCount} 个店铺优惠券周预算低于 ${couponBudget.targetBudget} ${couponBudget.currency}`,
      {stores: couponBudget.belowTargetStores},
    );
  }
  if (couponBudget.missingEvidenceCount > 0) {
    addBlocker(
      blockers,
      'coupon_budget_missing_evidence',
      `${couponBudget.missingEvidenceCount} 个店铺缺少优惠券预算 execute 回读证据`,
      {
        selectedSource: couponBudget.selectedSource,
        stores: couponBudget.missingEvidenceStores,
        executeSource: couponBudget.evidenceSource,
        dryRunSource: couponBudget.dryRunSource,
      },
    );
  }
  if (couponBudget.writeFailureButAtTargetCount > 0) {
    contextWarnings.push({
      code: 'coupon_budget_write_failed_but_at_target',
      label: 'couponBudget',
      message: `${couponBudget.writeFailureButAtTargetCount} 个店铺写入返回异常，但 before/after 回读预算已达到 ${couponBudget.targetBudget} ${couponBudget.currency}；不阻断 no-action，但保留异常证据`,
      evidence: {stores: couponBudget.writeFailureButAtTargetStores},
    });
  }
  for (const cmd of suggestedDryRunCommands) {
    const violations = validateSuggestedCommand(cmd.command);
    if (violations.length) addBlocker(blockers, 'unsafe_suggested_command', `${cmd.label} 命令不安全`, {command: cmd.command, violations});
  }

  const report = {
    schemaVersion: 1,
    mode: 'read-only',
    createdAt: now.toISOString(),
    reportDate: args.date,
    sourceFiles: sources,
    safety,
    couponSubmitDryRun,
    lowPriceOverlap,
    oldOrdinaryOverlap,
    knownOrdinaryActivityGuard,
    aboveTargetActions,
    newSkcCandidates,
    orderPriceAudit,
    biPortalFreshness,
    biPortalSourceSelection: {
      selectedPath: biPortal.source?.path || '',
      selectedStatus: biPortal.source?.status || '',
      selectedTransport: biPortal.source?.transport || 'local-file',
      fallbackUsed: biPortal.source?.fallbackUsed === true,
      diagnostics: (biPortalSelection.diagnostics || []).map(d => ({
        type: d.type,
        status: d.source?.status || '',
        path: d.source?.path || '',
        error: d.source?.error || '',
      })),
    },
    marketingStackReviewFreshness: marketingStackReviewContext || null,
    marketingStackReviewCoverage,
    t3MarketingCandidates,
    couponBudget,
    budgetDryRun: budgetDryRun.source.status === 'missing'
      ? {status: 'unknown', reason: 'no coupon budget dry-run source found'}
      : {status: budgetDryRun.source.status, path: budgetDryRun.source.path},
    blockers,
    sourceWarnings,
    contextWarnings,
    unknownSources,
    changesSincePrevious: [],
    noActionSummary: '',
    suggestedDryRunCommands,
  };
  report.orderPriceAudit.ignoredNoWindowFiles = orderAuditSelection.ignoredNoWindowFiles;
  report.changesSincePrevious = buildChangesSincePrevious(report, loadPreviousGuardReport(args.date));
  const canNoAction = !report.blockers.length
    && !report.sourceWarnings.length
    && !report.unknownSources.length
    && !report.t3MarketingCandidates.length
    && !report.newSkcCandidates.recentMissingExactPlanOnShelf
    && !report.newSkcCandidates.unknownAgeMissingExactPlanOnShelf
    && !report.newSkcCandidates.needsPricing
    && !report.newSkcCandidates.needsConfirmation
    && !report.newSkcCandidates.needsAgeReview
    && !report.newSkcCandidates.needsCouponReview
    && !report.aboveTargetActions.count
    && !report.lowPriceOverlap.belowTarget
    && !report.lowPriceOverlap.missingEvidence
    && !report.lowPriceOverlap.cancelRows
    && !report.oldOrdinaryOverlap.riskCancel
    && !report.oldOrdinaryOverlap.cancelRows
    && !report.knownOrdinaryActivityGuard.belowTargetCount
    && !report.knownOrdinaryActivityGuard.evidenceIncompleteCount
    && !report.knownOrdinaryActivityGuard.missingFinalTargetPriceCount;
  if (canNoAction) {
    report.noActionSummary = '当前已有证据未显示需要动作；仅保持每日巡检。';
  } else if (!report.blockers.length) {
    report.noActionSummary = '无阻塞项，但存在观察/建议项或数据源提醒；请按报告查看是否需要人工确认。';
  } else {
    report.noActionSummary = '存在阻塞项；需要刷新证据或人工处理后，才能形成安全的 no-action 结论。';
  }
  report.humanSummary = buildHumanSummary(report);

  await fs.mkdir(args.outDir, {recursive: true});
  const jsonPath = path.join(args.outDir, `marketing-daily-guard-${args.date}.json`);
  const mdPath = path.join(args.outDir, `marketing-daily-guard-${args.date}.md`);
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, buildMarkdown(report), 'utf8');
  console.log(JSON.stringify({ok: true, mode: report.mode, json: rel(jsonPath), md: rel(mdPath), blockers: report.blockers.length}, null, 2));
}

await main().catch(err => {
  console.error(err);
  process.exit(1);
});
