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
import {spawn} from 'node:child_process';
import {
  DEFAULT_CLOUD_BI_ROOT as SHARED_DEFAULT_CLOUD_BI_ROOT,
  DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS as SHARED_DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
  DEFAULT_CLOUD_BI_MAX_BYTES as SHARED_DEFAULT_CLOUD_BI_MAX_BYTES,
  selectBiPortalSource as selectSharedBiPortalSource,
} from '../../lib/bi_portal_source.mjs';
import {
  classifyLimitedDiscountCouponStack,
  classifyCouponEligibilityRow,
  couponPlanStoreView,
  findCouponPlanRow,
  loadCouponTargetEligibilityPlan,
} from '../../lib/marketing_coupon_policy.mjs';
import {summarizeCouponBudgetStatus} from '../../lib/marketing_coupon_budget_guard.mjs';
import {
  buildMarketingStackDetailIndex,
  classifyKnownOrdinaryCouponStack,
  groupOrdinaryEvidenceBySkc,
  loadKnownOrdinaryPriceEvidence,
  stackRowsHaveExistingOrdinaryMarketingLabel,
} from '../../lib/marketing_ordinary_price_evidence.mjs';
import {
  buildOrdinaryPlatformTierEvidenceIndex,
  findActiveOrdinaryPlatformTier,
  loadOrdinaryPlatformTierRegistry,
} from '../../lib/marketing_ordinary_platform_tier_evidence.mjs';
import {summarizeStackReviewCoverage} from '../../lib/marketing_stack_review_coverage.mjs';
import {
  DEFAULT_MARKETING_PRICING_POLICY,
  deriveTopTreatmentTargetFromCost,
  hasOrdinaryMarketingEvidence,
  isRecentNewListingLink,
  loadMarketingPricingPolicy,
  unwrapBiLinksData,
} from '../../lib/marketing_pricing_policy.mjs';
import {
  collectRelistedLinkHistoryEvidence,
  marketingLinkKey,
} from '../../lib/marketing_relisted_link_history.mjs';
import {
  assessLatestRawMarketingLinkCoverage,
  collectLatestRawMarketingLinkRows,
  mergeMarketingLinkRows,
} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {
  buildManualLimitedDiscountIndex,
  classifyManualLimitedDiscountLiveState,
  findActiveManualLimitedDiscount,
  loadManualLimitedDiscountRegistry,
  manualLimitedDiscountKey,
  selectManualLimitedDiscountCoverageRows,
} from '../../lib/marketing_manual_limited_discount_overrides.mjs';
import {
  buildHighClickLowConversionSpecialAudit,
  buildHighClickSpecialEffectAudit,
  getHighClickSpecialPolicy,
} from '../../lib/marketing_high_click_special_policy.mjs';
import {
  DRIFT_FIX_RESULT_FILE_PATTERN,
  isDriftFixResultEligibleForReport,
} from '../../lib/marketing_order_mitigation_history.mjs';
import {normalizeLimitedRepairResult} from '../../lib/marketing_limited_repair_status.mjs';

import {resolveCurrentMarketingPlanPair} from '../../lib/marketing_plan_selector.mjs';
function readJsonSafe(file) {
  try {
    return JSON.parse(fsSync.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const DEFAULT_MAX_AGE_HOURS = 72;
const MARKETING_SIGNUP_DIR = path.join(ROOT, 'tmp', 'marketing-signup');
const TARGET_PLAN_LEGACY_DEFAULT = path.join(MARKETING_SIGNUP_DIR, 'selection-plan-2026-06-03-ALL-ready.json');
const PRICE_OVERRIDES_LEGACY_DEFAULT = path.join(MARKETING_SIGNUP_DIR, 'price-overrides-2026-06-03-ALL-ready.json');
const BI_PORTAL_DATA_DEFAULT = path.join(ROOT, 'outputs', 'bi-portal', 'data.json');
const BI_PORTAL_LINKS_DATA_DEFAULT = path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'linksData.json');
const MARKETING_PRICING_POLICY_DEFAULT = path.join(ROOT, 'config', 'marketing_pricing_policy.json');
const MARKETING_COST_MAP_DEFAULT = path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json');
const HIGH_CLICK_EFFECT_LEDGER_DEFAULT = path.join(ROOT, 'state', 'marketing_high_click_special_effects.json');
const SHEIN_LINK_HISTORY_DIR = path.join(ROOT, 'outputs', 'shein_links');
const STORES_CONFIG_DEFAULT = path.join(ROOT, 'config', 'stores.json');
const ALLOWED_LIMITED_COUPON_OVERLAPS_DEFAULT = path.join(ROOT, 'config', 'marketing_allowed_limited_coupon_overlaps.json');
const COUPON_CANCEL_RESULTS_DIR = path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-cancel-results');
const DEADLINE_FILL_RESULTS_DIR = resolveDeadlineFillResultsDir();
const NEW_SKC_SHELF_AGE_DAYS = 30;
const NEW_LISTING_LIMITED_MAX_ROWS = 60;
const NEW_SKC_MAX_ROWS = 80;
const DEFAULT_CLOUD_BI_ROOT = SHARED_DEFAULT_CLOUD_BI_ROOT;
const DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS = SHARED_DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS;
const DEFAULT_CLOUD_BI_MAX_BYTES = SHARED_DEFAULT_CLOUD_BI_MAX_BYTES;
const MARKETING_STACK_REVIEW_MAX_AGE_HOURS = 48;
const CLOUD_ORDER_LOOKBACK_DAYS = 1;
const ORDER_PRICE_TOLERANCE_SAR = 1;
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
  'marketingStackReview',
]);
const LEGACY_COUPON_EVIDENCE_SOURCE_LABELS = new Set([
  'couponSubmitLatestSummary',
  'lowPriceOverlapLive',
  'lowPriceOverlapCancelList',
  'oldOrdinaryOverlapLive',
  'oldOrdinaryOverlapCancelList',
]);
const NON_EXPIRING_VERSIONED_SOURCE_LABELS = new Set([
  'storesConfig',
  'targetSelectionPlan',
  'priceOverridesPlan',
]);

function parseArgs(argv) {
  const args = {
    date: formatLocalDate(new Date()),
    outDir: DEFAULT_OUT_DIR,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    biPortalData: BI_PORTAL_DATA_DEFAULT,
    biPortalLinksData: BI_PORTAL_LINKS_DATA_DEFAULT,
    targetPlan: '',
    priceOverrides: '',
    targetPlanExplicit: false,
    priceOverridesExplicit: false,
    storesConfig: STORES_CONFIG_DEFAULT,
    cloudBiSsh: '',
    cloudBiRoot: DEFAULT_CLOUD_BI_ROOT,
    cloudBiSshTimeoutMs: DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
    cloudBiMaxBytes: DEFAULT_CLOUD_BI_MAX_BYTES,
    now: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') args.date = String(argv[++i] || '').trim();
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--max-age-hours') args.maxAgeHours = Number(argv[++i]);
    else if (a === '--bi-portal-data') args.biPortalData = path.resolve(argv[++i]);
    else if (a === '--bi-portal-links-data') args.biPortalLinksData = path.resolve(argv[++i]);
    else if (a === '--target-plan') {
      args.targetPlan = path.resolve(argv[++i]);
      args.targetPlanExplicit = true;
    } else if (a === '--price-overrides') {
      args.priceOverrides = path.resolve(argv[++i]);
      args.priceOverridesExplicit = true;
    }
    else if (a === '--stores-config') args.storesConfig = path.resolve(argv[++i]);
    else if (a === '--cloud-bi-ssh') args.cloudBiSsh = String(argv[++i] || '').trim();
    else if (a === '--cloud-bi-root') args.cloudBiRoot = String(argv[++i] || '').trim();
    else if (a === '--cloud-bi-ssh-timeout-ms') args.cloudBiSshTimeoutMs = Number(argv[++i]);
    else if (a === '--cloud-bi-max-bytes') args.cloudBiMaxBytes = Number(argv[++i]);
    else if (a === '--now') args.now = String(argv[++i] || '').trim();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`Invalid --date ${args.date}; expected YYYY-MM-DD`);
  if (!Number.isFinite(args.maxAgeHours) || args.maxAgeHours <= 0) args.maxAgeHours = DEFAULT_MAX_AGE_HOURS;
  if (!Number.isFinite(args.cloudBiSshTimeoutMs) || args.cloudBiSshTimeoutMs <= 0) args.cloudBiSshTimeoutMs = DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS;
  if (!Number.isFinite(args.cloudBiMaxBytes) || args.cloudBiMaxBytes <= 0) args.cloudBiMaxBytes = DEFAULT_CLOUD_BI_MAX_BYTES;
  const parsedNow = args.now ? parseAnyDateTime(args.now) : null;
  if (args.now && !parsedNow) throw new Error(`Invalid --now ${args.now}; expected parseable local/ISO datetime`);
  args.planSelection = resolveCurrentMarketingPlanPair({
    targetPlan: args.targetPlan,
    priceOverrides: args.priceOverrides,
    targetPlanExplicit: args.targetPlanExplicit,
    priceOverridesExplicit: args.priceOverridesExplicit,
    nowMs: parsedNow ? parsedNow.getTime() : Date.now(),
  });
  args.targetPlan = args.planSelection.targetPlan;
  args.priceOverrides = args.planSelection.priceOverrides;
  return args;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatLocalDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalDateTime(d) {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return '';
  return `${formatLocalDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
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

function dateToMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const normalized = raw.replace(' ', 'T');
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}+08:00`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : 0;
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

function latestCurrentMarketingLiveScanFile(dir, regex, storesConfigDoc) {
  const files = listFiles(dir, regex);
  const enabledStoreCount = Array.isArray(storesConfigDoc?.stores)
    ? storesConfigDoc.stores.filter(store => store?.enabled !== false).length
    : 0;
  const inspected = [];
  const newest = files[0] || '';
  if (newest) {
    const doc = readJsonSafe(newest);
    const stat = fsSync.statSync(newest);
    const freshHours = (Date.now() - stat.mtimeMs) / 36e5;
    // Prefer today's/fresh live scan even when one store hit login page. Using
    // an older all-green scan hides the actual blocker and violates the live
    // evidence rule.
    if (doc && doc?.partial !== true && freshHours <= 24) return newest;
  }
  for (const file of files.slice(0, 20)) {
    const doc = readJsonSafe(file);
    const rows = Array.isArray(doc?.rows) ? doc.rows : [];
    const storeCount = new Set(rows.map(row => normKey(row.storeKey || row.store_key || row.store)).filter(Boolean)).size;
    inspected.push({file, storeCount, ok: doc?.ok !== false, partial: doc?.partial === true});
    if (doc?.ok !== false && doc?.partial !== true && enabledStoreCount > 0 && storeCount >= enabledStoreCount) {
      return file;
    }
  }
  return inspected[0]?.file || '';
}

function latestReportFile(regex) {
  return latestFile(DEFAULT_OUT_DIR, regex);
}

function resolveDeadlineFillResultsDir() {
  const base = path.join(ROOT, 'tmp', 'mbrs');
  const defaultDir = path.join(base, 'deadline-fill-results');
  if (fsSync.existsSync(defaultDir)) return defaultDir;
  if (!fsSync.existsSync(base)) return defaultDir;
  const candidates = fsSync.readdirSync(base, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^deadline-fill-results/i.test(entry.name))
    .map(entry => path.join(base, entry.name))
    .sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs);
  return candidates[0] || defaultDir;
}

function rowActivityKey(row) {
  return [
    normKey(row?.storeKey || row?.store || row?.['店铺']),
    String(Number(row?.activityId || row?.activity_id || row?.['活动ID'] || 0) || ''),
    normSku(row?.skc || row?.SKC || row?.['SKC']),
  ].join('::');
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
  const detailIndex = buildMarketingStackDetailIndex(stackDoc);
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

      if (stackRowsHaveExistingOrdinaryMarketingLabel(stackRows)) {
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

function collectDeadlineHandledKeys(gapfillResultDoc) {
  const handled = new Set();
  const addRows = rows => {
    for (const row of rows || []) {
      const key = rowActivityKey(row);
      if (!key.includes('::::') && !key.endsWith('::')) handled.add(key);
    }
  };
  addRows(gapfillResultDoc?.submittedRows);
  addRows(gapfillResultDoc?.blockedRows);
  return handled;
}

function summarizeT3Candidates(stackDoc, reportDate, handledDeadlineKeys = new Set()) {
  const start = parseLocalDateTime(`${reportDate} 00:00:00`);
  // Business meaning of "T-3" is calendar-day based in Asia/Shanghai:
  // when the report runs on 2026-06-08, activities ending any time on
  // 2026-06-11 must be visible. A strict 72-hour cutoff from midnight would
  // stop at 2026-06-11 00:00:00 and miss common 23:59:59 signup deadlines.
  const end = new Date(start.getTime() + 3 * 24 * 60 * 60 * 1000);
  end.setHours(23, 59, 59, 999);
  const grouped = new Map();
  let handledRows = 0;
  for (const row of stackDoc?.detailRows || []) {
    const deadline = parseLocalDateTime(row['报名截止']);
    if (!deadline || deadline < start || deadline > end) continue;
    if (String(row['活动类型'] || '').includes('优惠券')) continue;
    if (handledDeadlineKeys.has(rowActivityKey(row))) {
      handledRows += 1;
      continue;
    }
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
  const rows = [...grouped.values()].sort((a, b) => String(a.signupDeadline).localeCompare(String(b.signupDeadline)));
  Object.defineProperty(rows, 'handledRows', {value: handledRows, enumerable: false});
  return rows;
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

function parseActiveLimitedCouponOverlapAllowlist(now) {
  const doc = readJsonSafe(ALLOWED_LIMITED_COUPON_OVERLAPS_DEFAULT) || {};
  return (Array.isArray(doc.entries) ? doc.entries : []).filter(entry => {
    const validUntil = parseAnyDateTime(entry?.validUntil || '');
    return !validUntil || validUntil.getTime() >= now.getTime();
  });
}

function findApprovedBelowTargetOverlap(entries, row) {
  const activityId = Number(row.limitedDiscountActivityId || 0);
  const couponActivityId = Number(row.couponActivityId || 0);
  const levelRuleId = Number(row.levelRuleId || 0);
  const storeKey = normKey(row.storeKey);
  const skc = normSku(row.skc);
  for (const entry of entries || []) {
    if (entry?.allowBelowTarget !== true) continue;
    const approvedStore = normKey(entry.storeKey || '*');
    if (approvedStore !== '*' && approvedStore !== storeKey) continue;
    if (normSku(entry.skc) !== skc) continue;
    if (Number(entry.limitedDiscountActivityId || 0) !== activityId) continue;
    if (Number(entry.couponActivityId || 0) !== couponActivityId) continue;
    if (Number(entry.levelRuleId || 0) !== levelRuleId) continue;
    const approvedFinal = numberOrNull(entry.approvedFinalWithCoupon);
    const maxApprovedLoss = numberOrNull(entry.maxApprovedLossSar);
    const finalWithCoupon = numberOrNull(row.finalWithCoupon);
    const targetFinalPrice = numberOrNull(row.targetFinalPrice);
    if (approvedFinal === null || maxApprovedLoss === null || finalWithCoupon === null || targetFinalPrice === null) continue;
    const liveLoss = round2(targetFinalPrice - finalWithCoupon);
    if (finalWithCoupon < approvedFinal - 0.01 || liveLoss > maxApprovedLoss + 0.01) continue;
    return {...entry, liveLoss};
  }
  return null;
}

function summarizeFreshLiveLowPriceOverlap({
  stackDoc,
  stackSource,
  stackCoverage,
  liveScanSource,
  couponPlan,
  storesConfigDoc,
  now,
}) {
  const enabledStores = enabledStoreKeysFromConfig(storesConfigDoc);
  const enabledSet = new Set(enabledStores);
  const stackCouponRows = Array.isArray(stackDoc?.couponRows) ? stackDoc.couponRows : [];
  const storeStatuses = Array.isArray(stackDoc?.storeStatuses) ? stackDoc.storeStatuses : [];
  const expectedCouponRows = storeStatuses
    .filter(status => enabledSet.has(normKey(status?.storeKey || status?.store)))
    .reduce((sum, status) => sum + Number(status?.couponCount || 0), 0);
  const couponRuleFailures = stackCouponRows.filter(row => row?._raw?.coupon15Rule?.ok !== true);
  const couponRowsByEnabledStore = stackCouponRows.filter(row => enabledSet.has(normKey(row?.['店铺'] || row?.storeKey || row?.store)));

  const liveDoc = liveScanSource?.data || {};
  const liveStores = Array.isArray(liveDoc.stores) ? liveDoc.stores : [];
  const liveStoreByKey = new Map(liveStores.map(store => [normKey(store?.storeKey || store?.store || store), store]));
  const liveMissingStores = enabledStores.filter(storeKey => {
    const status = liveStoreByKey.get(storeKey);
    return !status || status?.ok !== true;
  });
  const stackEvidenceAt = parseAnyDateTime(stackDoc?.activityScanFinishedAt || stackDoc?.activityScanCreatedAt || stackDoc?.createdAt || '');
  const liveEvidenceAt = parseAnyDateTime(liveDoc?.updatedAt || liveDoc?.createdAt || liveDoc?.generatedAt || '');
  const stackEvidenceAgeHours = stackEvidenceAt ? ageHours(now, stackEvidenceAt) : null;
  const liveEvidenceAgeHours = liveEvidenceAt ? ageHours(now, liveEvidenceAt) : null;
  const evidenceSkewMinutes = stackEvidenceAt && liveEvidenceAt
    ? Math.round(Math.abs(stackEvidenceAt.getTime() - liveEvidenceAt.getTime()) / 6000) / 10
    : null;
  const reasons = [];
  if (stackSource?.status !== 'ok') reasons.push(`marketing_stack_source_${stackSource?.status || 'missing'}`);
  if (!stackCoverage?.coverageComplete) reasons.push('marketing_stack_store_coverage_incomplete');
  if (couponRowsByEnabledStore.length !== expectedCouponRows) reasons.push('coupon_summary_count_mismatch');
  if (couponRuleFailures.length) reasons.push('coupon_rule_query_failed');
  if (liveScanSource?.source?.status !== 'ok') reasons.push(`current_marketing_live_scan_${liveScanSource?.source?.status || 'missing'}`);
  if (liveDoc.ok !== true || liveDoc.partial === true) reasons.push('current_marketing_live_scan_not_complete');
  if (liveMissingStores.length) reasons.push('current_marketing_live_scan_store_coverage_incomplete');
  if (stackEvidenceAgeHours === null || stackEvidenceAgeHours > 2) reasons.push('marketing_stack_not_same_run_fresh');
  if (liveEvidenceAgeHours === null || liveEvidenceAgeHours > 2) reasons.push('current_marketing_live_scan_not_same_run_fresh');
  if (evidenceSkewMinutes === null || evidenceSkewMinutes > 30) reasons.push('live_coupon_and_limited_scan_not_same_run');
  if (!couponPlan) reasons.push('coupon_target_plan_unavailable');

  const base = {
    meaning: 'live 15% coupon enrolled set intersected with the same-run current/future ordinary and limited-discount price layers; final price uses the lowest known promotion price × coupon factor',
    source: 'fresh_marketing_stack_plus_current_price_live_scan',
    trusted: reasons.length === 0,
    reasons,
    belowTarget: 0,
    missingEvidence: 0,
    matchesTarget: 0,
    limitedFallbackAboveTarget: 0,
    aboveTarget: 0,
    cancelRows: 0,
    allStoresOk: reasons.length === 0,
    storeCount: enabledStores.length,
    expectedCouponRows,
    couponSummaryRows: couponRowsByEnabledStore.length,
    couponRuleFailureCount: couponRuleFailures.length,
    couponRuleFailureSamples: couponRuleFailures.slice(0, 10).map(row => ({
      storeKey: normKey(row?.['店铺'] || row?.storeKey || row?.store),
      activityId: row?.['优惠券活动ID'] || row?._raw?.activity?.activityId || '',
      levelRuleId: row?._raw?.coupon15Rule?.levelRuleId || '',
      error: row?._raw?.coupon15Rule?.error || row?._raw?.coupon15Rule?.reason || row?._raw?.coupon15Rule?.enrolledMsg || '',
    })),
    liveMissingStores,
    stackEvidenceAt: stackEvidenceAt?.toISOString() || '',
    liveEvidenceAt: liveEvidenceAt?.toISOString() || '',
    stackEvidenceAgeHours,
    liveEvidenceAgeHours,
    evidenceSkewMinutes,
    activeCouponCount: 0,
    activeCouponOutsideAllowedPlan: 0,
    activeCouponOutsideAllowedPlanRows: [],
    activeCouponOutsideAllowedPlanOverlap: 0,
    activeCouponOutsideAllowedPlanOverlapRows: [],
    activePromotionOverlapCount: 0,
    activeOrdinaryOverlapCount: 0,
    activeLimitedOverlapCount: 0,
    approvedBelowTargetCount: 0,
    rows: [],
  };
  if (!base.trusted) return base;

  const activeCouponByKey = new Map();
  for (const couponRow of couponRowsByEnabledStore) {
    const storeKey = normKey(couponRow?.['店铺'] || couponRow?.storeKey || couponRow?.store);
    const rule = couponRow?._raw?.coupon15Rule || {};
    const activityId = Number(couponRow?.['优惠券活动ID'] || couponRow?._raw?.activity?.activityId || 0);
    const activeRows = Array.isArray(rule.enrolledActiveRows)
      ? rule.enrolledActiveRows
      : (Array.isArray(rule.enrolledActiveSkcs) ? rule.enrolledActiveSkcs.map(skc => ({skc})) : []);
    for (const active of activeRows) {
      const skc = normSku(active?.skc);
      if (!storeKey || !skc) continue;
      activeCouponByKey.set(`${storeKey}::${skc}`, {
        storeKey,
        skc,
        supplierNo: active?.supplierNo || '',
        couponActivityId: activityId,
        levelRuleId: Number(rule.levelRuleId || 0),
        couponStatus: String(active?.status ?? ''),
      });
    }
  }
  base.activeCouponCount = activeCouponByKey.size;

  const promotionByKey = new Map();
  for (const row of Array.isArray(liveDoc.rows) ? liveDoc.rows : []) {
    const storeKey = normKey(row?.store_key || row?.storeKey || row?.store);
    const skc = normSku(row?.skc || row?.SKC);
    if (!enabledSet.has(storeKey) || !skc) continue;
    const key = `${storeKey}::${skc}`;
    const evidenceType = String(row?.marketing_price_evidence_type || row?.evidenceType || '');
    const candidates = [];
    const ordinaryPrice = numberOrNull(
      row?.marketing_suggested_ordinary_price_sar
      ?? row?.marketing_ordinary_price_sar
      ?? row?.ordinaryMarketingPrice
      ?? row?.ordinaryActivityPrice
    );
    if (/ordinary/i.test(evidenceType) || row?.marketing_activity_id) {
      candidates.push({
        promotionType: 'ordinary_marketing',
        promotionPrice: ordinaryPrice,
        promotionActivityId: Number(row?.marketing_activity_id || row?.ordinaryActivityId || row?.activityId || 0),
        promotionName: row?.marketing_activity_name || row?.ordinaryActivityName || row?.activityName || '',
        promotionStart: row?.marketing_activity_start || row?.ordinaryActivityStart || '',
        promotionEnd: row?.marketing_activity_end || row?.ordinaryActivityEnd || '',
      });
    }
    const limitedDiscountPrice = numberOrNull(
      row?.marketing_limited_discount_price_sar
      ?? row?.marketing_limited_discount_price
      ?? row?.limitedDiscountPrice
      ?? row?.limited_discount_price_sar
    );
    if (/limited/i.test(evidenceType) || row?.marketing_limited_discount_activity_id || limitedDiscountPrice !== null) {
      candidates.push({
        promotionType: 'limited_discount',
        promotionPrice: limitedDiscountPrice,
        promotionActivityId: Number(row?.marketing_limited_discount_activity_id || row?.limitedDiscountActivityId || row?.activityId || 0),
        promotionName: row?.marketing_limited_discount_name || row?.limitedDiscountName || row?.activityName || '',
        promotionStart: row?.marketing_limited_discount_start || row?.limitedDiscountStart || '',
        promotionEnd: row?.marketing_limited_discount_end || row?.limitedDiscountEnd || '',
      });
    }
    if (!candidates.length) continue;
    if (!promotionByKey.has(key)) promotionByKey.set(key, []);
    promotionByKey.get(key).push(...candidates.map(candidate => ({
      ...candidate,
      storeKey,
      skc,
      supplierNo: row?.standard_goods_sn || row?.supplier_no || row?.supplierNo || '',
      evidenceType,
    })));
  }

  const approvals = parseActiveLimitedCouponOverlapAllowlist(now);
  const decisionCounts = {};
  for (const [key, coupon] of activeCouponByKey) {
    const planRow = findCouponPlanRow(couponPlan, coupon.storeKey, coupon.skc);
    const outsideAllowedPlan = !planRow || planRow.allowed15 !== true;
    if (outsideAllowedPlan) {
      base.activeCouponOutsideAllowedPlan += 1;
      base.activeCouponOutsideAllowedPlanRows.push({
        ...coupon,
        category: planRow?.category || 'not_in_allowed_plan',
        reason: planRow?.reason || 'active_coupon_not_in_allowed15_plan',
      });
    }
    const promotions = promotionByKey.get(key) || [];
    if (!promotions.length) continue;
    base.activePromotionOverlapCount += 1;
    if (outsideAllowedPlan) {
      base.activeCouponOutsideAllowedPlanOverlap += 1;
      base.activeCouponOutsideAllowedPlanOverlapRows.push({...coupon, promotionCandidates: promotions});
    }
    if (promotions.some(item => item.promotionType === 'ordinary_marketing')) base.activeOrdinaryOverlapCount += 1;
    if (promotions.some(item => item.promotionType === 'limited_discount')) base.activeLimitedOverlapCount += 1;
    const missingPricePromotion = promotions.find(item => item.promotionPrice === null);
    const effectivePromotion = promotions
      .filter(item => item.promotionPrice !== null)
      .sort((a, b) => a.promotionPrice - b.promotionPrice)[0] || missingPricePromotion;
    if (missingPricePromotion) {
      const result = {
        ...coupon,
        ...missingPricePromotion,
        priceDecision: `missing_${missingPricePromotion.promotionType}_price`,
        shouldCancelCoupon: false,
        promotionCandidates: promotions,
      };
      decisionCounts[result.priceDecision] = (decisionCounts[result.priceDecision] || 0) + 1;
      base.missingEvidence += 1;
      base.rows.push(result);
      continue;
    }
    const priceGuardInput = {
      skc: coupon.skc,
      supplierNo: effectivePromotion?.supplierNo || coupon.supplierNo,
      limitedDiscountPrice: effectivePromotion?.promotionPrice,
    };
    const priceGuard = classifyLimitedDiscountCouponStack(priceGuardInput, planRow, {fallbackDiscountPct: 15});
    const result = {
      ...coupon,
      ...effectivePromotion,
      promotionCandidates: promotions,
      limitedDiscountPrice: effectivePromotion?.promotionPrice,
      limitedDiscountActivityId: effectivePromotion?.promotionType === 'limited_discount' ? effectivePromotion.promotionActivityId : 0,
      couponFactor: priceGuard.couponFactor,
      finalWithCoupon: priceGuard.finalWithCoupon,
      targetFinalPrice: priceGuard.finalTargetPrice,
      safetyFloor: priceGuard.safetyFloor,
      diff: priceGuard.diff,
      priceDecision: priceGuard.decision,
      shouldCancelCoupon: priceGuard.shouldCancelCoupon,
      belowTargetApproved: false,
      approvalReason: '',
    };
    const approval = priceGuard.shouldCancelCoupon && effectivePromotion?.promotionType === 'limited_discount'
      ? findApprovedBelowTargetOverlap(approvals, result)
      : null;
    if (approval) {
      result.shouldCancelCoupon = false;
      result.belowTargetApproved = true;
      result.approvalReason = approval.reason || '';
      base.approvedBelowTargetCount += 1;
    }
    const decision = String(result.priceDecision || 'unknown');
    decisionCounts[decision] = (decisionCounts[decision] || 0) + 1;
    if (decision.startsWith('missing_')) base.missingEvidence += 1;
    if (result.shouldCancelCoupon) base.belowTarget += 1;
    if (/matches_(?:target|safety_floor)$/.test(decision)) base.matchesTarget += 1;
    if (/above_(?:target|safety_floor)$/.test(decision)) base.limitedFallbackAboveTarget += 1;
    base.rows.push(result);
  }
  base.aboveTarget = base.limitedFallbackAboveTarget;
  base.cancelRows = base.belowTarget;
  base.priceDecisionCounts = decisionCounts;
  base.activeCouponOutsideAllowedPlanRows = base.activeCouponOutsideAllowedPlanRows.slice(0, 30);
  base.activeCouponOutsideAllowedPlanOverlapRows = base.activeCouponOutsideAllowedPlanOverlapRows.slice(0, 30);
  base.rows = base.rows.slice(0, 100);
  return base;
}

function buildNewListingPriceIndex(priceOverridesDoc, priceOverridesSourcePath = '') {
  const primary = buildSingleNewListingPriceIndex(priceOverridesDoc, priceOverridesSourcePath, {isSupplemental: false});
  return {
    ...primary,
    supplemental: loadSupplementalNewListingPriceIndexesSync(priceOverridesSourcePath),
  };
}

function buildSingleNewListingPriceIndex(priceOverridesDoc, sourcePath = '', {isSupplemental = false} = {}) {
  const byExact = new Map();
  const byCanonical = new Map();
  for (const item of priceOverridesDoc?.items || []) {
    const storeKey = normKey(item?.storeKey || item?.store || item?.['店铺']);
    const skc = normSku(item?.skc || item?.SKC || item?.['SKC']);
    const canonical = normSku(item?.canonical || item?.standard_goods_sn || item?.standardGoodsSn || item?.['标准货号'] || item?.supplierNo);
    const finalTargetPrice = numberOrNull(item?.finalTargetPrice ?? item?.targetPrice);
    if (!canonical || finalTargetPrice === null || finalTargetPrice <= 0) continue;
    const row = {
      storeKey,
      skc,
      canonical,
      finalTargetPrice,
      targetPrice: numberOrNull(item?.targetPrice) ?? finalTargetPrice,
      isTopExposureLink: item?.isTopExposureLink === true || item?.newListingTopTreatment === true,
      newListingTopTreatment: item?.newListingTopTreatment === true,
      note: item?.note || item?.combo || '',
    };
    if (storeKey && skc) byExact.set(`${storeKey}::${skc}`, row);
    const key = canonicalKey(canonical);
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(row);
  }
  return {
    byExact,
    byCanonical,
    sourcePath,
    isSupplemental,
    rowCount: Array.isArray(priceOverridesDoc?.items) ? priceOverridesDoc.items.length : 0,
    createdAt: priceOverridesDoc?.createdAt || '',
    baselineForLimitedDiscountFallback: priceOverridesDoc?.baselineForLimitedDiscountFallback === true,
  };
}

function loadSupplementalNewListingPriceIndexesSync(primarySourcePath = '') {
  const dir = path.join(ROOT, 'tmp', 'marketing-signup');
  if (!fsSync.existsSync(dir)) return [];
  const primaryResolved = primarySourcePath ? path.resolve(ROOT, primarySourcePath) : '';
  const candidates = [];
  for (const entry of fsSync.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isFile() || !/^price-overrides-.*\.json$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (primaryResolved && path.resolve(full) === primaryResolved) continue;
    let doc = null;
    try {
      doc = JSON.parse(fsSync.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    const items = Array.isArray(doc?.items) ? doc.items : [];
    if (items.length < 100) continue;
    if (doc?.scope?.repairOnly === true) continue;
    if (doc?.baselineForLimitedDiscountFallback !== true && doc?.baselineForNextOrdinaryActivity !== true) continue;
    const stat = fsSync.statSync(full);
    candidates.push({
      full,
      doc,
      score: Math.max(dateToMs(doc?.createdAt), stat.mtimeMs)
        + (doc?.baselineForLimitedDiscountFallback === true ? 10_000_000 : 0),
    });
  }
  candidates.sort((a, b) => b.score - a.score || String(a.full).localeCompare(String(b.full)));
  return candidates.slice(0, 6).map(candidate => buildSingleNewListingPriceIndex(candidate.doc, rel(candidate.full), {isSupplemental: true}));
}

function findNewListingPriceEvidence(index, canonical, storeKey = '', skc = '', {allowCanonicalFallback = true} = {}) {
  const primary = findNewListingPriceEvidenceInSingleIndex(index, canonical, storeKey, skc, {allowCanonicalFallback});
  if (primary) return annotateNewListingPriceEvidence(primary, index);
  for (const supplemental of index?.supplemental || []) {
    const evidence = findNewListingPriceEvidenceInSingleIndex(supplemental, canonical, storeKey, skc, {allowCanonicalFallback});
    if (evidence) return annotateNewListingPriceEvidence(evidence, supplemental);
  }
  return null;
}

function findNewListingPriceEvidenceInSingleIndex(index, canonical, storeKey = '', skc = '', {allowCanonicalFallback = true} = {}) {
  const exact = index?.byExact?.get(`${normKey(storeKey)}::${normSku(skc)}`);
  if (exact) {
    return {
      canonical: exact.canonical || canonical,
      rowCount: 1,
      topRowCount: exact.isTopExposureLink || exact.newListingTopTreatment ? 1 : 0,
      topTierPrice: round2(exact.finalTargetPrice),
      otherTierPrice: null,
      allPriceMin: round2(exact.finalTargetPrice),
      sourceScope: 'exact_store_skc',
      topTierSamples: [{storeKey: exact.storeKey, skc: exact.skc, finalTargetPrice: exact.finalTargetPrice, note: exact.note || ''}],
    };
  }
  if (!allowCanonicalFallback) return null;
  const rows = index?.byCanonical?.get(canonicalKey(canonical)) || [];
  if (!rows.length) return null;
  const topRows = rows.filter(row => row.isTopExposureLink || row.newListingTopTreatment);
  const topPrices = topRows.map(row => row.finalTargetPrice).filter(Number.isFinite);
  const otherPrices = rows.filter(row => !(row.isTopExposureLink || row.newListingTopTreatment)).map(row => row.finalTargetPrice).filter(Number.isFinite);
  const allPrices = rows.map(row => row.finalTargetPrice).filter(Number.isFinite);
  return {
    canonical: rows[0]?.canonical || canonical,
    rowCount: rows.length,
    topRowCount: topRows.length,
    topTierPrice: representativePrice(topPrices),
    otherTierPrice: representativePrice(otherPrices),
    allPriceMin: allPrices.length ? round2(Math.min(...allPrices)) : null,
    sourceScope: 'canonical',
    topTierSamples: topRows.slice(0, 8).map(row => ({storeKey: row.storeKey, skc: row.skc, finalTargetPrice: row.finalTargetPrice, note: row.note || ''})),
  };
}

function annotateNewListingPriceEvidence(evidence, index) {
  if (!evidence) return null;
  return {
    ...evidence,
    priceOverridesSource: index?.sourcePath || '',
    supplementalPriceEvidence: index?.isSupplemental === true,
  };
}

function resolveNewListingTopTierPrice(priceEvidence) {
  if (!priceEvidence) return {price: null, source: 'missing_price_evidence'};
  const explicit = numberOrNull(priceEvidence.topTierPrice);
  if (explicit !== null && explicit > 0) {
    return {price: round2(explicit), source: priceEvidence.topRowCount ? 'explicit_top_tier_price' : 'exact_store_skc_target_price'};
  }
  const allMin = numberOrNull(priceEvidence.allPriceMin);
  const other = numberOrNull(priceEvidence.otherTierPrice);
  if (allMin !== null && allMin > 0 && (other === null || allMin <= other + 0.01)) {
    return {price: round2(allMin), source: 'derived_from_lowest_approved_same_canonical_target_price'};
  }
  return {price: null, source: 'missing_top_tier_price'};
}

function representativePrice(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  return round2(nums[Math.floor((nums.length - 1) / 2)]);
}

function canonicalKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[()（）【】\[\]_:：/\\-]/g, '')
    .toUpperCase();
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
  const finalTargetPrice = numberOrNull(row?.finalTargetPrice);
  if (finalTargetPrice === null) return false;
  return classifyCouponEligibilityRow(row, {targetDiscountPct: 15}).allowed15 === true;
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

function isMarketingPlanOnShelf(link) {
  if (link?.is_on_shelf === false || link?.is_on_shelf === 0 || link?.is_on_shelf === '0') return false;
  return !/下架|已售罄|售罄/.test(String(link?.shelf_status_name || link?.shelf_statuses || ''));
}

function collectLiveLimitedDiscountEvidence(liveScanSource) {
  const source = liveScanSource?.source || {};
  const doc = liveScanSource?.data || {};
  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  const bySkc = new Map();
  const manualBySkc = new Map();
  const anyBySkc = new Map();
  const newListingBySkc = new Map();
  const newListingAnyBySkc = new Map();
  const sourceStatus = source.status || 'missing';
  if (sourceStatus !== 'ok' || doc.ok === false) {
    return {status: sourceStatus, path: source.path || '', bySkc, manualBySkc, anyBySkc, newListingBySkc, newListingAnyBySkc, complete: false};
  }
  for (const row of rows) {
    const storeKey = normKey(row.store_key || row.storeKey || row.store);
    const skc = normSku(row.skc || row.SKC);
    if (!storeKey || !skc) continue;
    const key = `${storeKey}::${skc}`;
    const limitedPrice = numberOrNull(
      row.marketing_limited_discount_price_sar
      ?? row.marketing_limited_discount_price
      ?? row.limitedDiscountPrice
      ?? row.limited_discount_price_sar
    );
    const isLimitedEvidence = (
      row.marketing_limited_discount_is_current === true
      || row.marketing_limited_discount_is_current === 1
      || row.marketing_limited_discount_is_current === '1'
      || /limited/i.test(String(row.marketing_price_evidence_type || row.evidenceType || ''))
      || limitedPrice !== null
    );
    if (!isLimitedEvidence) continue;
    const evidence = {
      price: limitedPrice,
      name: row.marketing_limited_discount_name || row.limitedDiscountName || row.activityName || '',
      activityId: row.marketing_limited_discount_activity_id || row.limitedDiscountActivityId || row.activityId || '',
      start: row.marketing_limited_discount_start || row.limitedDiscountStart || '',
      end: row.marketing_limited_discount_end || row.limitedDiscountEnd || '',
      activityStock: numberOrNull(row.marketing_limited_discount_attend_num_sum ?? row.activityStock ?? row.attendNumSum),
      stock: numberOrNull(row.marketing_limited_discount_stock_num ?? row.stockNum),
      evidenceType: row.marketing_price_evidence_type || row.evidenceType || '',
      sourceAt: row.marketing_price_source_at || row.sourceAt || doc.createdAt || doc.generatedAt || '',
    };
    if (!manualBySkc.has(key)) manualBySkc.set(key, []);
    manualBySkc.get(key).push(evidence);
    const isCurrentEvidence = isCurrentMarketingEvidenceRow(row);
    const isFutureNewListingFallback = !isCurrentEvidence
      && isLiveNewListingLimitedDiscountCovered([{name: evidence.name}]);
    if (isCurrentEvidence || isFutureNewListingFallback) {
      if (!newListingAnyBySkc.has(key)) newListingAnyBySkc.set(key, []);
      newListingAnyBySkc.get(key).push(row);
      if (!newListingBySkc.has(key)) newListingBySkc.set(key, []);
      newListingBySkc.get(key).push(evidence);
    }
    if (!isCurrentEvidence) continue;
    if (!anyBySkc.has(key)) anyBySkc.set(key, []);
    anyBySkc.get(key).push(row);
    if (!bySkc.has(key)) bySkc.set(key, []);
    bySkc.get(key).push(evidence);
  }
  return {status: sourceStatus, path: source.path || '', bySkc, manualBySkc, anyBySkc, newListingBySkc, newListingAnyBySkc, complete: doc.partial !== true};
}

function summarizeLimitedDiscountTargetPriceDrift({liveScanSource, priceOverridesDoc, priceOverridesSourcePath, activityWindowEvidence, now, manualLimitedDiscountRegistry, linksDataDoc = null, linksDataSourcePath = ''}) {
  const live = collectLiveLimitedDiscountEvidence(liveScanSource);
  const manualIndex = buildManualLimitedDiscountIndex(manualLimitedDiscountRegistry, now);
  const plan = buildOrderTargetPlanIndex(priceOverridesDoc, priceOverridesSourcePath, activityWindowEvidence, linksDataDoc, linksDataSourcePath);
  const rows = [];
  const manualRows = [];
  const missingPlanRows = [];
  const dataQualityRows = [];
  if (live.status !== 'ok') {
    return {
      status: live.status || 'missing',
      source: live.path || '',
      planSourcePath: priceOverridesSourcePath,
      checked: 0,
      belowTarget: 0,
      belowRows: [],
      missingPlanRows: [],
      dataQualityRows: [],
      byStore: {},
      samples: [],
      manualSpecialLimitedDiscount: {
        registrySource: manualLimitedDiscountRegistry?.sourcePath || '',
        activeCount: manualIndex.activeByKey.size,
        rows: [],
        missingRows: [],
        priceMismatchRows: [],
        coverageMismatchRows: [],
        coveredRows: [],
      },
    };
  }
  const nowText = formatLocalDateTime(now);
  for (const entry of manualIndex.activeByKey.values()) {
    const key = manualLimitedDiscountKey(entry.storeKey, entry.skc);
    const selectedCoverage = selectManualLimitedDiscountCoverageRows(entry, {
      currentRows: live.bySkc.get(key) || [],
      allRows: live.manualBySkc.get(key) || [],
      at: now,
    });
    const liveRows = selectedCoverage.rows;
    const liveState = classifyManualLimitedDiscountLiveState(entry, liveRows);
    const scheduledExact = liveState.status === 'covered_exact'
      && selectedCoverage.scheduledRows.length > 0
      && classifyManualLimitedDiscountLiveState(entry, selectedCoverage.currentRows).status !== 'covered_exact';
    const candidates = plan.rowsBySkc.get(key) || [];
    manualRows.push({
      storeKey: entry.storeKey,
      skc: entry.skc,
      canonical: entry.canonical || '',
      status: liveState.status,
      specialPrice: entry.specialPrice,
      ordinaryFinalTargetPrice: candidates.length ? selectOrderPlanRow(candidates, nowText).planRow?.finalTargetPrice ?? null : null,
      livePrices: liveState.livePrices,
      liveCoverage: liveState.liveCoverage || [],
      coverageMode: scheduledExact ? 'scheduled_future_exact' : 'current_exact',
      scheduledStartTimes: scheduledExact
        ? [...new Set(selectedCoverage.scheduledRows.map(row => row.start).filter(Boolean))]
        : [],
      activityIds: [...new Set(liveRows.map(row => row.activityId).filter(Boolean))],
      activityNames: [...new Set(liveRows.map(row => row.name).filter(Boolean))],
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      activityStock: entry.activityStock,
      currentActivityId: entry.currentActivityId,
      sourceThreadId: entry.sourceThreadId,
      sourceArtifact: entry.sourceArtifact,
      actionRequired: liveState.status !== 'covered_exact',
      action: liveState.status === 'covered_exact'
        ? scheduledExact
          ? '用户批准的特殊限时折扣已精确排期，等待生效并禁止普通漂移修复重复覆盖'
          : '用户批准的特殊限时折扣价格精确命中，保持并禁止普通漂移修复覆盖'
        : liveState.status === 'missing'
          ? '人工特殊限时折扣缺失：恢复登记中的精确特殊价；库存不足时先核 ET 实盘'
          : '恢复登记中的精确人工特殊价；库存不足时仅在 ET 实盘足够后补平台虚拟库存',
    });
  }
  for (const [key, liveRows] of live.bySkc.entries()) {
    const [storeKey, skc] = key.split('::');
    const manualEntry = manualIndex.activeByKey.get(key) || null;
    const candidates = plan.rowsBySkc.get(key) || [];
    if (manualEntry) continue;
    if (!candidates.length) {
      missingPlanRows.push({storeKey, skc, reason: 'no price-overrides row for live limited-discount skc'});
      continue;
    }
    const selectedPlan = selectOrderPlanRow(candidates, nowText);
    if (selectedPlan.status !== 'active_window') {
      dataQualityRows.push({storeKey, skc, planWindowStatus: selectedPlan.status, reason: 'no active target-price window for current live limited-discount'});
      continue;
    }
    const planRow = selectedPlan.planRow;
    if (planRow.finalTargetPrice === null) {
      dataQualityRows.push({storeKey, skc, planWindowStatus: selectedPlan.status, reason: 'active target-price row missing finalTargetPrice'});
      continue;
    }
    for (const liveRow of liveRows || []) {
      const price = numberOrNull(liveRow.price);
      if (price === null) {
        dataQualityRows.push({storeKey, skc, reason: 'live limited-discount row missing price', activityName: liveRow.name || ''});
        continue;
      }
      const deltaSar = round2(price - planRow.finalTargetPrice);
      rows.push({
        storeKey,
        skc,
        canonical: planRow.canonical || '',
        limitedDiscountPrice: price,
        finalTargetPrice: planRow.finalTargetPrice,
        originalPlanFinalTargetPrice: planRow.originalPlanFinalTargetPrice ?? null,
        targetPriceSource: planRow.sourceType || planRow.targetPriceSource || '',
        linkTargetSourcePath: planRow.linkTargetSourcePath || '',
        linkTargetNote: planRow.linkTargetNote || '',
        deltaSar,
        toleranceSar: ORDER_PRICE_TOLERANCE_SAR,
        status: deltaSar < -ORDER_PRICE_TOLERANCE_SAR ? 'limited_discount_below_current_target' : 'ok',
        activityId: planRow.activityId || '',
        planStartTime: planRow.planStartTime || '',
        planEndTime: planRow.planEndTime || '',
        planWindowStatus: selectedPlan.status,
        duplicateResolution: selectedPlan.duplicateResolution || '',
        limitedDiscountName: liveRow.name || '',
        limitedDiscountStart: liveRow.start || '',
        limitedDiscountEnd: liveRow.end || '',
        evidenceType: liveRow.evidenceType || '',
        sourceAt: liveRow.sourceAt || '',
      });
    }
  }
  const belowRows = rows.filter(row => row.status === 'limited_discount_below_current_target');
  const manualMissingRows = manualRows.filter(row => row.status === 'missing');
  const manualPriceMismatchRows = manualRows.filter(row => row.status === 'price_mismatch');
  const manualCoverageMismatchRows = manualRows.filter(row => row.status === 'coverage_mismatch');
  const manualCoveredRows = manualRows.filter(row => row.status === 'covered_exact');
  return {
    status: 'ok',
    source: live.path || '',
    planSourcePath: priceOverridesSourcePath,
    checked: rows.length,
    belowTarget: belowRows.length,
    allRows: rows.slice(0, 1200),
    belowRows: belowRows.slice(0, 200),
    missingPlanRows: missingPlanRows.slice(0, 80),
    dataQualityRows: dataQualityRows.slice(0, 80),
    byStore: countBy(belowRows, 'storeKey'),
    samples: belowRows.slice(0, 20),
    manualSpecialLimitedDiscount: {
      registrySource: manualLimitedDiscountRegistry?.sourcePath || '',
      activeCount: manualIndex.activeByKey.size,
      checked: manualRows.length,
      actionCount: manualMissingRows.length + manualPriceMismatchRows.length + manualCoverageMismatchRows.length,
      byStatus: countBy(manualRows, 'status'),
      rows: manualRows,
      missingRows: manualMissingRows,
      priceMismatchRows: manualPriceMismatchRows,
      coverageMismatchRows: manualCoverageMismatchRows,
      coveredRows: manualCoveredRows,
    },
  };
}

function isLiveNewListingLimitedDiscountCovered(rows) {
  return (rows || []).some(row => /新上架.*限时折扣|重新上架.*限时折扣|高曝光兜底限时折扣|Top5兜底限时折扣|new\s*listing|relisted/i.test(String(row.name || '')));
}

function hasBiActiveMarketingSignal(link) {
  const statusText = String(link?.activity_label || link?.activity_status || '').trim();
  const futureOnly = /即将开始|待生效|未开始|future/i.test(statusText)
    && !/营销中|活动中|生效中|current|active/i.test(statusText);
  if (!futureOnly && hasOrdinaryMarketingEvidence(link)) return true;
  if (
    link?.marketing_limited_discount_is_current === true
    || link?.marketing_limited_discount_is_current === 1
    || link?.marketing_limited_discount_is_current === '1'
    || numberOrNull(link?.marketing_limited_discount_price_sar ?? link?.marketing_limited_discount_price ?? link?.limitedDiscountPrice) !== null
    || numberOrNull(link?.marketing_coupon_factor ?? link?.couponFactor) !== null
  ) return true;
  const text = [
    link?.activity_label,
    link?.performance_activity_names,
    link?.marketing_activity_names,
    link?.activity_names,
  ].filter(Boolean).join(' ');
  if (futureOnly) return false;
  return /营销中|活动中|生效中|普通活动|营销活动|限时折扣|优惠券|coupon|campaign|limited\s*discount/i.test(text);
}

function isCurrentMarketingEvidenceRow(row) {
  const evidenceType = String(row?.marketing_price_evidence_type || row?.evidenceType || '').trim();
  if (/^future_/i.test(evidenceType)) return false;
  if (/^current_/i.test(evidenceType)) return true;
  if (row?.marketing_limited_discount_is_current === false || row?.marketing_limited_discount_is_current === 0 || row?.marketing_limited_discount_is_current === '0') return false;
  return true;
}

function collectNewListingLimitedDiscountExecutionEvidence(reportDate) {
  const file = path.join(DEFAULT_OUT_DIR, `new-listing-7d-limited-discount-execution-summary-${reportDate}.json`);
  const doc = readJsonSafe(file);
  const bySkc = new Map();
  if (!doc || !Array.isArray(doc.results)) return {source: exists(file) ? rel(file) : '', bySkc};
  for (const result of doc.results) {
    if (result?.status !== 'executed') continue;
    if (result?.execute?.result?.ok === false) continue;
    const storeKey = normKey(result.storeKey);
    if (!storeKey) continue;
    const targetSkcs = Array.isArray(result.targetSkcs) ? result.targetSkcs : [];
    const after = result?.execute?.result?.after || {};
    const uncovered = new Set((Array.isArray(after.uncoveredAfter) ? after.uncoveredAfter : []).map(normSku));
    const duplicate = new Set((Array.isArray(after.duplicateOverlapSkcs) ? after.duplicateOverlapSkcs : []).map(normSku));
    for (const rawSkc of targetSkcs) {
      const skc = normSku(rawSkc);
      if (!skc || uncovered.has(skc) || duplicate.has(skc)) continue;
      bySkc.set(`${storeKey}::${skc}`, {
        source: rel(file),
        activityId: result.createdActivityId || result?.execute?.result?.createdActivityId || null,
        targetCount: result.targetCount || result?.execute?.result?.targetCount || null,
      });
    }
  }
  return {source: rel(file), bySkc};
}

function summarizeNewSkcCandidates({biDoc, biSource, linksDataDoc, linksDataSource, selectionPlanDoc, priceOverridesDoc, priceOverridesSourcePath = '', storesConfigDoc, pricingPolicy, reportDate, currentMarketingLiveScanSource, manualLimitedDiscountRegistry, now}) {
  const unwrappedLinksData = unwrapBiLinksData(linksDataDoc);
  const unwrappedBiDoc = unwrapBiLinksData(biDoc);
  const baseLinks = Array.isArray(unwrappedLinksData.storeLinks) && unwrappedLinksData.storeLinks.length
    ? unwrappedLinksData.storeLinks
    : (Array.isArray(unwrappedBiDoc.storeLinks) ? unwrappedBiDoc.storeLinks : []);
  const latestRawLinks = collectLatestRawMarketingLinkRows({
    historyDir: SHEIN_LINK_HISTORY_DIR,
    reportDate,
    storeKeys: (storesConfigDoc?.stores || []).filter(store => store?.enabled !== false).map(store => store.storeKey),
  });
  const mergedLinks = mergeMarketingLinkRows(baseLinks, latestRawLinks.rows);
  const links = mergedLinks.rows;
  const effectiveBiSource = (Array.isArray(unwrappedLinksData.storeLinks) && unwrappedLinksData.storeLinks.length)
    ? linksDataSource
    : biSource;
  const enabledStores = new Set();
  const knownStores = new Set();
  for (const store of storesConfigDoc?.stores || []) {
    const storeKey = normKey(store.storeKey);
    if (!storeKey) continue;
    knownStores.add(storeKey);
    if (store.enabled !== false) enabledStores.add(storeKey);
  }
  const latestRawLinkCoverage = assessLatestRawMarketingLinkCoverage({
    sourceFiles: latestRawLinks.sourceFiles,
    errors: latestRawLinks.errors,
    storeKeys: [...enabledStores],
  });
  const plan = collectPlanEvidence(selectionPlanDoc, priceOverridesDoc);
  const newListingPriceIndex = buildNewListingPriceIndex(priceOverridesDoc, priceOverridesSourcePath);
  const ignored = [];
  const rows = [];
  const byDecision = {};
  let onShelfRows = 0;
  let missingExactPlanOnShelf = 0;
  let recentMissingExactPlanOnShelf = 0;
  let unknownAgeMissingExactPlanOnShelf = 0;
  let exactPlannedRows = 0;
  let exactExcludedRows = 0;
  const newListingLimitedRows = [];
  const newListingPolicy = pricingPolicy || DEFAULT_MARKETING_PRICING_POLICY;
  const relistedPolicy = newListingPolicy?.relistedWithoutActiveMarketing || {};
  const costMapDoc = readJsonSafe(MARKETING_COST_MAP_DEFAULT) || {};
  const liveLimitedEvidence = collectLiveLimitedDiscountEvidence(currentMarketingLiveScanSource);
  const manualIndex = buildManualLimitedDiscountIndex(manualLimitedDiscountRegistry, now);
  const executionLimitedEvidence = collectNewListingLimitedDiscountExecutionEvidence(reportDate);
  const currentLinkKeys = new Set(links.map(link => marketingLinkKey(
    link.store_key || link.storeKey || link.store,
    link.skc || link.SKC,
  )).filter(key => !key.endsWith('::')));
  const relistedHistory = collectRelistedLinkHistoryEvidence({
    historyDir: SHEIN_LINK_HISTORY_DIR,
    reportDate,
    lookbackDays: relistedPolicy.historyLookbackDays || 60,
    currentKeys: currentLinkKeys,
    storeKeys: enabledStores,
  });

  for (const link of links) {
    const storeKey = normKey(link.store_key || link.storeKey || link.store);
    const skc = normSku(link.skc || link.SKC);
    const canonical = normSku(link.standard_goods_sn || link.standardGoodsSn || link.canonical);
    const isOnShelf = isMarketingPlanOnShelf(link);
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
    const recentNewListing = isRecentNewListingLink(link, newListingPolicy, reportDate);
    const relistedEvidence = relistedHistory.bySkc.get(exactKey) || null;
    const liveMarketingRows = liveLimitedEvidence.newListingAnyBySkc.get(exactKey) || [];
    const relistedApplies = relistedPolicy.enabled !== false
      && relistedHistory.status === 'ok'
      && relistedEvidence
      && (relistedPolicy.requireLatestSourceHasNoActivity === false || relistedEvidence.latestHasActivity === false)
      && (relistedPolicy.requireNoBiMarketingSignal === false || !hasBiActiveMarketingSignal(link))
      && (relistedPolicy.requireCompleteLiveMarketingScan === false || liveLimitedEvidence.complete)
      && liveMarketingRows.length === 0;
    if (recentNewListing.applies || relistedApplies) {
      const treatmentType = recentNewListing.applies ? 'new_listing_within_7d' : 'relisted_without_active_marketing';
      const liveLimitedRows = liveLimitedEvidence.newListingBySkc.get(exactKey) || [];
      const manualEntry = manualIndex.activeByKey.get(exactKey) || null;
      const manualLiveState = manualEntry ? classifyManualLimitedDiscountLiveState(manualEntry, liveLimitedRows) : null;
      const liveLimitedCoveredByName = isLiveNewListingLimitedDiscountCovered(liveLimitedRows);
      const liveLimitedPrice = liveLimitedRows.length ? numberOrNull(liveLimitedRows[0].price) : null;
      const limitedPrice = numberOrNull(
        liveLimitedPrice
        ?? link.marketing_limited_discount_price_sar
        ?? link.marketing_limited_discount_price
        ?? link.limitedDiscountPrice
      );
      const hasCurrentLimitedDiscount = (
        liveLimitedRows.length > 0
        || link.marketing_limited_discount_is_current === true
        || link.marketing_limited_discount_is_current === 1
        || link.marketing_limited_discount_is_current === '1'
        || limitedPrice !== null
      );
      const exactPriceEvidence = findNewListingPriceEvidence(newListingPriceIndex, canonical, storeKey, skc, {allowCanonicalFallback: false});
      const priceEvidence = exactPriceEvidence || findNewListingPriceEvidence(newListingPriceIndex, canonical, storeKey, skc);
      const planTopTier = resolveNewListingTopTierPrice(priceEvidence);
      const costTopTier = deriveTopTreatmentTargetFromCost({canonical, costDoc: costMapDoc, policy: newListingPolicy});
      const ordinaryTopTier = Number.isFinite(planTopTier.price) && planTopTier.price > 0 ? planTopTier : costTopTier;
      const resolvedTopTier = manualEntry
        ? {price: manualEntry.specialPrice, source: 'manual_special_limited_discount_override'}
        : ordinaryTopTier;
      const liveLimitedCoveredAtTarget = (manualEntry ? manualLiveState?.status === 'covered_exact' : liveLimitedCoveredByName)
        && Number.isFinite(resolvedTopTier.price)
        && limitedPrice !== null
        && round2(limitedPrice) + 0.010001 >= round2(resolvedTopTier.price);
      const liveLimitedCoveredNoTargetEvidence = liveLimitedCoveredByName && (!Number.isFinite(resolvedTopTier.price) || resolvedTopTier.price <= 0);
      const executionLimitedCovered = executionLimitedEvidence.bySkc.has(exactKey);
      const executionEvidence = executionLimitedEvidence.bySkc.get(exactKey) || null;
      const liveLimitedCovered = liveLimitedCoveredAtTarget || liveLimitedCoveredNoTargetEvidence || executionLimitedCovered;
      const actionRequired = !liveLimitedCovered;
      newListingLimitedRows.push({
        storeKey,
        skc,
        canonical,
        treatmentType,
        shelfAgeDays: recentNewListing.shelfAgeDays ?? numberOrNull(link.shelf_age_days ?? link.shelf_days),
        shelfAgeSource: recentNewListing.shelfAgeSource || 'historical_relist_transition',
        lastInactiveDate: relistedEvidence?.lastInactiveDate || '',
        lastInactiveStatus: relistedEvidence?.lastInactiveStatus || '',
        relistedAt: relistedEvidence?.relistedAt || '',
        relistedHistorySnapshotCount: relistedEvidence?.inactiveSnapshotCount || 0,
        relistedLatestSourceHasActivity: relistedEvidence?.latestHasActivity ?? null,
        c7EpsUv: numberOrNull(link.c7_eps_uv ?? link.c7EpsUv),
        currentPrice: numberOrNull(link.current_price_sar ?? link.currentPriceSar ?? link.current_price ?? link.original_supply_price_range_sar),
        limitedDiscountPrice: limitedPrice,
        plannedLimitedDiscountPrice: resolvedTopTier.price,
        finalTargetPrice: resolvedTopTier.price,
        ordinaryTopTierPrice: ordinaryTopTier.price,
        manualSpecialLimitedDiscount: Boolean(manualEntry),
        manualSpecialValidTo: manualEntry?.validTo || '',
        manualSpecialActivityStock: manualEntry?.activityStock || null,
        manualSpecialLiveStatus: manualLiveState?.status || '',
        targetPriceEvidenceScope: exactPriceEvidence
          ? 'exact_store_skc'
          : priceEvidence
            ? 'canonical_top_tier_fallback'
            : costTopTier.available
              ? 'product_cost_top_treatment_fallback'
              : '',
        topTierPriceSource: resolvedTopTier.source,
        priceEvidenceSourcePath: priceEvidence?.priceOverridesSource || (costTopTier.available ? rel(MARKETING_COST_MAP_DEFAULT) : ''),
        supplementalPriceEvidence: priceEvidence?.supplementalPriceEvidence === true,
        priceEvidenceAvailable: Boolean(priceEvidence) || costTopTier.available === true,
        productUnitCostSar: costTopTier.productUnitCostSar ?? null,
        storageUnitCostSar: costTopTier.storageUnitCostSar ?? null,
        selectionCostBasis: costTopTier.selectionCostBasis || '',
        priceEvidenceBlocked: actionRequired && (!Number.isFinite(resolvedTopTier.price) || resolvedTopTier.price <= 0),
        hasCurrentLimitedDiscount,
        liveLimitedDiscountEvidenceCount: liveLimitedRows.length,
        liveLimitedDiscountCovered: liveLimitedCovered,
        liveLimitedDiscountCoveredByName: liveLimitedCoveredByName,
        liveLimitedDiscountCoveredAtTarget: liveLimitedCoveredAtTarget,
        executionLimitedDiscountCovered: executionLimitedCovered,
        executionLimitedDiscountSource: executionEvidence?.source || '',
        executionLimitedDiscountActivityId: executionEvidence?.activityId || null,
        liveLimitedDiscountNames: [...new Set(liveLimitedRows.map(row => row.name).filter(Boolean))],
        liveLimitedDiscountSource: liveLimitedEvidence.path || '',
        ordinaryMarketingEvidence: hasOrdinaryMarketingEvidence(link),
        performanceActivityNames: link.performance_activity_names || '',
        actionRequired,
        action: manualEntry && manualLiveState?.status !== 'covered_exact'
          ? `人工特殊限时折扣${manualLiveState?.status === 'missing' ? '缺失' : '错价'}：恢复精确特殊价 ${manualEntry.specialPrice} SAR，有效至 ${manualEntry.validTo}`
          : executionLimitedCovered
          ? '自动执行摘要已证明Top5待遇一周兜底限时折扣已创建并回读覆盖，无需重复写入'
          : liveLimitedCovered
          ? (liveLimitedCoveredAtTarget
            ? 'live scan 已证明Top5待遇一周兜底限时折扣已覆盖且不低于当前目标价，无需重复写入'
            : 'live scan 已证明Top5待遇一周兜底限时折扣已覆盖；但缺当前目标价证据，暂不重复写入')
          : hasCurrentLimitedDiscount
          ? '已有旧限时折扣：按Top5待遇规则复核一周窗口/价格，不符合则安全取消重报'
          : treatmentType === 'relisted_without_active_marketing'
            ? `历史 ${relistedEvidence.lastInactiveDate} ${relistedEvidence.lastInactiveStatus || '下架/售罄'}、${relistedEvidence.relistedAt} 恢复在售且当前无生效营销活动：立即按曝光前五/新链接力度自动报一周限时折扣`
            : '缺限时折扣：按新规则需立即自动报一周限时折扣，价格按曝光前五力度',
      });
    }
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
      platformSaleableStockEvidence: 'bi_linksData_signal_only_not_live_inventory_guard',
      performanceActivityNames: link.performance_activity_names || '',
      healthBucket: link.health_bucket || '',
      exactPlan: false,
      exactExcludedReason: exactExcluded?.reason || '',
      sameStandardPlan: summarizeStandardPlanEvidence(sameStandard),
      couponDryRunEligible,
      couponDryRunReason: couponDryRunEligible
        ? '已被共享券策略明确标记为可选流量 15% 券，可进入 dry-run 评估'
        : '缺明确可选流量券标记；历史 couponFactor=0.85 不能再生成 15% 券 dry-run 建议',
    });
  }
  rows.sort((a, b) => {
    const av = Number(a.c7EpsUv || 0);
    const bv = Number(b.c7EpsUv || 0);
    if (bv !== av) return bv - av;
    return String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc));
  });
  newListingLimitedRows.sort((a, b) => {
    const av = Number(a.c7EpsUv || 0);
    const bv = Number(b.c7EpsUv || 0);
    if (bv !== av) return bv - av;
    return String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.skc).localeCompare(String(b.skc));
  });
  const stale = effectiveBiSource?.status === 'stale';
  const actionRows = newListingLimitedRows.filter(row => row.actionRequired !== false);
  const coveredNoActionRows = newListingLimitedRows.filter(row => row.actionRequired === false);
  const missingLimitedRows = actionRows.filter(row => !row.hasCurrentLimitedDiscount);
  const existingLimitedRows = actionRows.filter(row => row.hasCurrentLimitedDiscount);
  const rescueFiles = findNewListingLimitedDiscountRescueFiles(reportDate, actionRows);
  const priceEvidenceBlockedRows = actionRows.filter(row => row.priceEvidenceBlocked);
  const executableActionRows = actionRows.filter(row => !row.priceEvidenceBlocked);
  return {
    status: stale ? 'stale_observation_only' : 'ok',
    source: effectiveBiSource?.path || '',
    sourceGeneratedAt: (Array.isArray(unwrappedLinksData.storeLinks) && unwrappedLinksData.storeLinks.length)
      ? (linksDataDoc?.generatedAt || unwrappedLinksData.generatedAt || '')
      : (biDoc?.generatedAt || unwrappedBiDoc.generatedAt || ''),
    linkDate: unwrappedLinksData?.dates?.linkDate || unwrappedBiDoc?.dates?.linkDate || '',
    recentWindowDays: NEW_SKC_SHELF_AGE_DAYS,
    newListingWithin7DaysLimitedDiscount: {
      enabled: newListingPolicy?.newListingWithin7Days?.enabled !== false,
      scope: 'new_listing_within_7d_or_relisted_without_active_marketing',
      windowDays: Number(newListingPolicy?.newListingWithin7Days?.windowDays || 7),
      relistedRuleEnabled: relistedPolicy.enabled !== false,
      relistedHistoryLookbackDays: Number(relistedPolicy.historyLookbackDays || 60),
      relistedHistoryStatus: relistedHistory.status,
      relistedHistorySource: rel(SHEIN_LINK_HISTORY_DIR),
      relistedHistorySourceFileCount: relistedHistory.sourceFileCount,
      relistedHistoryParseErrorCount: relistedHistory.parseErrorCount,
      relistedHistoryCandidateCount: relistedHistory.rows.length,
      source: effectiveBiSource?.path || '',
      totalRows: newListingLimitedRows.length,
      newListingWithin7DaysCount: newListingLimitedRows.filter(row => row.treatmentType === 'new_listing_within_7d').length,
      relistedWithoutActiveMarketingCount: newListingLimitedRows.filter(row => row.treatmentType === 'relisted_without_active_marketing').length,
      missingLimitedDiscountCount: missingLimitedRows.length,
      existingLimitedDiscountRebuildCount: existingLimitedRows.length,
      liveCoveredNoActionCount: coveredNoActionRows.length,
      liveLimitedDiscountSource: liveLimitedEvidence.path || '',
      actionCount: actionRows.length,
      executableActionCount: executableActionRows.length,
      priceEvidenceBlockedCount: priceEvidenceBlockedRows.length,
      supplementalPriceOverrides: (newListingPriceIndex.supplemental || []).map(index => ({
        path: index.sourcePath || '',
        rowCount: index.rowCount || 0,
        createdAt: index.createdAt || '',
        baselineForLimitedDiscountFallback: index.baselineForLimitedDiscountFallback === true,
      })),
      byStore: countBy(actionRows, 'storeKey'),
      rescueFiles,
      readyDryRunCount: rescueFiles.reduce((sum, file) => sum + Number(file.count || 0), 0),
      rows: actionRows.slice(0, NEW_LISTING_LIMITED_MAX_ROWS),
      priceEvidenceBlockedRows: priceEvidenceBlockedRows.slice(0, NEW_LISTING_LIMITED_MAX_ROWS),
      coveredRows: coveredNoActionRows.slice(0, NEW_LISTING_LIMITED_MAX_ROWS),
    },
    storeLinksRows: links.length,
    baseStoreLinksRows: mergedLinks.baseRowCount,
    latestRawLinkOverlay: {
      source: rel(SHEIN_LINK_HISTORY_DIR),
      ...latestRawLinkCoverage,
      sourceFileCount: latestRawLinks.sourceFiles.length,
      sourceFiles: latestRawLinks.sourceFiles.map(file => ({...file, path: rel(file.path)})),
      parseErrorCount: latestRawLinks.errors.length,
      errors: latestRawLinks.errors.slice(0, 20),
      rawRowCount: mergedLinks.rawRowCount,
      addedRowCount: mergedLinks.addedRowCount,
      addedRows: mergedLinks.addedRows.slice(0, 60).map(row => ({
        storeKey: row.store_key,
        skc: row.skc,
        canonical: row.standard_goods_sn,
        linkDate: row.link_date,
        firstShelfTime: row.first_shelf_time,
        source: rel(row.raw_link_snapshot_source),
      })),
    },
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


function findNewListingLimitedDiscountRescueFiles(reportDate, actionRows = []) {
  if (!Array.isArray(actionRows) || actionRows.length === 0) return [];
  const expectedDir = path.join(ROOT, 'tmp', 'marketing-signup', 'limited-discount-fallback', `new-listing-7d-${reportDate}`);
  if (!fsSync.existsSync(expectedDir)) return [];
  const neededStores = new Set((actionRows || []).map(row => row.storeKey).filter(Boolean));
  return fsSync.readdirSync(expectedDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      const full = path.join(expectedDir, name);
      try {
        const doc = JSON.parse(fsSync.readFileSync(full, 'utf8'));
        const storeKey = normKey(doc.storeKey || name.match(/new-listing-7d-limited-([A-Z0-9]+)-/)?.[1] || '');
        const count = Array.isArray(doc.rows) ? doc.rows.length : 0;
        return {
          storeKey,
          path: rel(full),
          count,
          createdAt: doc.createdAt || '',
          purpose: doc.purpose || '',
          endTime: doc.endTime || '',
          activityNamePrefix: doc.activityNamePrefix || '',
        };
      } catch {
        return null;
      }
    })
    .filter(file => file && file.count > 0 && (!neededStores.size || neededStores.has(file.storeKey)))
    .sort((a, b) => String(a.storeKey).localeCompare(String(b.storeKey)));
}

function addDaysToLocalDate(dateStr, deltaDays) {
  const d = parseLocalDateTime(`${dateStr} 00:00:00`);
  if (!d) return '';
  d.setDate(d.getDate() + Number(deltaDays || 0));
  return formatLocalDate(d);
}

function reportDateLookbackDates(reportDate, lookbackDays = CLOUD_ORDER_LOOKBACK_DAYS) {
  const dates = [];
  for (let i = 0; i <= lookbackDays; i += 1) {
    const date = addDaysToLocalDate(reportDate, -i);
    if (date && !dates.includes(date)) dates.push(date);
  }
  return dates;
}

function enabledStoreKeysFromConfig(storesConfigDoc) {
  return (storesConfigDoc?.stores || [])
    .filter(store => store?.enabled !== false)
    .map(store => normKey(store.storeKey || store.store || store.key))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "'\"'\"'")}'`;
}

function doubleQuoteArg(value) {
  return `"${String(value ?? '').replaceAll('"', '\\"')}"`;
}

function validateCloudOrderFetchArgs({cloudBiSsh, cloudBiRoot}) {
  const host = String(cloudBiSsh || '').trim();
  const root = String(cloudBiRoot || DEFAULT_CLOUD_BI_ROOT).trim();
  if (!host) return {ok: false, reason: 'empty_host'};
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return {ok: false, reason: 'invalid_host_alias', host};
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root)) return {ok: false, reason: 'invalid_cloud_bi_root', root};
  return {ok: true, host, root: root.replace(/\/+$/, '')};
}

function isLocalCloudHost(host) {
  return ['local', 'localhost', '127.0.0.1'].includes(String(host || '').trim().toLowerCase());
}

function execLimited(command, args, {timeoutMs, maxBytes}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell: false});
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        try { child.kill('SIGKILL'); } catch {}
        finish(reject, new Error(`stdout exceeds max bytes ${maxBytes}`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderrChunks.push(chunk);
    });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        finish(reject, new Error(`exit=${code}${stderr ? ` stderr=${stderr.slice(0, 500)}` : ''}`));
      } else {
        finish(resolve, stdout);
      }
    });
  });
}

async function readCloudSheinFetchOrderRows({
  cloudBiSsh,
  cloudBiRoot,
  cloudBiSshTimeoutMs,
  cloudBiMaxBytes,
  stores,
  dates,
}) {
  const validation = validateCloudOrderFetchArgs({cloudBiSsh, cloudBiRoot});
  const useLocalFiles = validation.ok && isLocalCloudHost(validation.host);
  const base = {
    transport: useLocalFiles ? 'local-file' : 'ssh',
    host: validation.host || '',
    root: validation.root || '',
    status: validation.ok ? 'ok' : 'invalid_config',
    error: validation.ok ? '' : validation.reason,
    files: [],
  };
  if (!validation.ok) return base;
  const safeStores = [...new Set((stores || []).map(normKey).filter(store => /^[A-Z0-9_-]+$/.test(store)))].sort();
  const safeDates = [...new Set((dates || []).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort().reverse();
  const remoteScriptPath = path.join(ROOT, 'scripts', 'cloud_read_order_files.py');
  const remoteScript = fsSync.readFileSync(remoteScriptPath, 'utf8');
  const command = [
    'python3',
    '-c',
    shellQuote(remoteScript),
    shellQuote(validation.root),
    shellQuote(safeStores.join(',')),
    shellQuote(safeDates.join(',')),
  ].join(' ');
  try {
    const text = useLocalFiles
      ? await execLimited('python3', ['-c', remoteScript, validation.root, safeStores.join(','), safeDates.join(',')], {
        timeoutMs: cloudBiSshTimeoutMs,
        maxBytes: cloudBiMaxBytes,
      })
      : await execLimited('ssh', [validation.host, command], {
        timeoutMs: cloudBiSshTimeoutMs,
        maxBytes: cloudBiMaxBytes,
      });
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    return {
      ...base,
      status: 'ok',
      stores: safeStores,
      dates: safeDates,
      files: Array.isArray(data.files) ? data.files : [],
    };
  } catch (err) {
    return {
      ...base,
      status: 'fetch_error',
      error: err.message,
      stores: safeStores,
      dates: safeDates,
      files: [],
    };
  }
}

function planActivityKey(storeKey, activityId) {
  const store = normKey(storeKey);
  const activity = String(activityId || '').trim();
  return store && activity ? `${store}::${activity}` : '';
}

function collectRequiredActivityKeys(...docs) {
  const keys = new Set();
  const activities = new Set();
  for (const doc of docs) {
    const data = unwrapBiLinksData(doc);
    const rows = [
      ...(Array.isArray(doc?.items) ? doc.items : []),
      ...(Array.isArray(data?.storeLinks) ? data.storeLinks : []),
      ...(Array.isArray(data?.links) ? data.links : []),
    ];
    for (const row of rows) {
      const storeKey = normKey(row?.storeKey || row?.store_key || row?.store || row?.['店铺']);
      const activityId = String(row?.activityId || row?.marketing_activity_id || row?.['活动ID'] || '').trim();
      if (!activityId) continue;
      activities.add(activityId);
      const key = planActivityKey(storeKey, activityId);
      if (key) keys.add(key);
    }
  }
  return {keys, activities};
}

function normalizeActivityWindowFromDoc(doc, sourcePath) {
  const activity = doc?.activity || doc?.activityInfo || {};
  const raw = activity.raw || doc?.raw || {};
  const activityId = String(activity.activityId || activity.activity_id || raw.activity_id || doc?.activityId || '').trim();
  const eventStart = activity.eventStart || activity.event_start || activity.startZoneTime || raw.start_zone_time || raw.eventStart || '';
  const eventEnd = activity.eventEnd || activity.event_end || activity.endZoneTime || raw.end_zone_time || raw.eventEnd || '';
  const startDate = parseAnyDateTime(eventStart);
  const endDate = parseAnyDateTime(eventEnd);
  if (!activityId || !eventStart || !eventEnd || !startDate || !endDate) return null;
  return {
    activityId,
    activityName: activity.name || activity.activityName || raw.activity_name || '',
    eventStart,
    eventEnd,
    startMs: startDate.getTime(),
    endMs: endDate.getTime(),
    sourcePath,
  };
}

function normalizeActivityWindowFromStackReviewRow(row, sourcePath) {
  const rawActivity = row?._raw?.activity || {};
  const raw = rawActivity.raw || {};
  const activityId = String(
    row?.['活动ID']
    || rawActivity.activityId
    || rawActivity.activity_id
    || raw.activity_id
    || '',
  ).trim();
  const eventStart = row?.['普通活动开始']
    || rawActivity.eventStart
    || rawActivity.event_start
    || raw.start_zone_time
    || '';
  const eventEnd = row?.['普通活动结束']
    || rawActivity.eventEnd
    || rawActivity.event_end
    || raw.end_zone_time
    || '';
  const startDate = parseAnyDateTime(eventStart);
  const endDate = parseAnyDateTime(eventEnd);
  if (!activityId || !eventStart || !eventEnd || !startDate || !endDate) return null;
  return {
    activityId,
    activityName: row?.['活动名称'] || rawActivity.name || raw.activity_name || '',
    eventStart,
    eventEnd,
    startMs: startDate.getTime(),
    endMs: endDate.getTime(),
    sourcePath,
  };
}

function loadActivityWindowEvidence(...docs) {
  const required = collectRequiredActivityKeys(...docs);
  const byStoreActivity = new Map();
  const byActivity = new Map();
  const inspected = [];
  if (!fsSync.existsSync(DEADLINE_FILL_RESULTS_DIR)) {
    return {
      status: 'missing_dir',
      sourceDir: rel(DEADLINE_FILL_RESULTS_DIR),
      requiredStoreActivityCount: required.keys.size,
      requiredActivityCount: required.activities.size,
      foundStoreActivityCount: 0,
      foundActivityCount: 0,
      missingStoreActivityKeys: [...required.keys].sort(),
      inspected,
      byStoreActivity,
      byActivity,
    };
  }
  for (const file of listFiles(DEADLINE_FILL_RESULTS_DIR, /^[A-Z0-9]+-\d+\.json$/i)) {
    const base = path.basename(file, '.json');
    const match = base.match(/^([A-Z0-9]+)-(\d+)$/i);
    if (!match) continue;
    const storeKey = normKey(match[1]);
    const activityId = String(match[2]);
    const storeActivityKey = planActivityKey(storeKey, activityId);
    if (
      required.keys.size
      && !required.keys.has(storeActivityKey)
      && !required.activities.has(activityId)
    ) {
      continue;
    }
    try {
      const doc = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      const window = normalizeActivityWindowFromDoc(doc, rel(file));
      inspected.push({
        path: rel(file),
        storeKey,
        activityId,
        ok: Boolean(window),
        eventStart: window?.eventStart || '',
        eventEnd: window?.eventEnd || '',
      });
      if (!window) continue;
      const item = {...window, storeKey};
      if (!byStoreActivity.has(storeActivityKey)) byStoreActivity.set(storeActivityKey, item);
      if (!byActivity.has(activityId)) byActivity.set(activityId, item);
    } catch (err) {
      inspected.push({path: rel(file), storeKey, activityId, ok: false, error: err.message});
    }
  }
  const unresolvedActivities = new Set(
    [...required.activities].filter(activityId => !byActivity.has(activityId)),
  );
  const unresolvedStoreActivityKeys = new Set(
    [...required.keys].filter(key => !byStoreActivity.has(key)),
  );
  if (unresolvedActivities.size || unresolvedStoreActivityKeys.size) {
    for (const file of listFiles(DEFAULT_OUT_DIR, /^marketing-stack-review-\d{4}-\d{2}-\d{2}\.json$/i).slice(0, 30)) {
      try {
        const doc = JSON.parse(fsSync.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const rows = Array.isArray(doc?.detailRows) ? doc.detailRows : [];
        let matchedRows = 0;
        for (const row of rows) {
          const storeKey = normKey(row?.['店铺'] || row?.storeKey || row?.store);
          const activityId = String(row?.['活动ID'] || row?.activityId || '').trim();
          const storeActivityKey = planActivityKey(storeKey, activityId);
          if (
            !unresolvedActivities.has(activityId)
            && !unresolvedStoreActivityKeys.has(storeActivityKey)
          ) {
            continue;
          }
          const window = normalizeActivityWindowFromStackReviewRow(row, rel(file));
          if (!window) continue;
          const item = {...window, storeKey};
          if (storeActivityKey && !byStoreActivity.has(storeActivityKey)) {
            byStoreActivity.set(storeActivityKey, item);
            unresolvedStoreActivityKeys.delete(storeActivityKey);
          }
          if (!byActivity.has(activityId)) {
            byActivity.set(activityId, item);
            unresolvedActivities.delete(activityId);
          }
          matchedRows += 1;
        }
        if (matchedRows) {
          inspected.push({
            path: rel(file),
            sourceType: 'marketing_stack_review',
            ok: true,
            matchedRows,
          });
        }
        if (!unresolvedActivities.size && !unresolvedStoreActivityKeys.size) break;
      } catch (err) {
        inspected.push({
          path: rel(file),
          sourceType: 'marketing_stack_review',
          ok: false,
          error: err.message,
        });
      }
    }
  }
  const missingStoreActivityKeys = [...required.keys]
    .filter(key => !byStoreActivity.has(key))
    .sort();
  return {
    status: missingStoreActivityKeys.length ? 'partial' : 'ok',
    sourceDir: rel(DEADLINE_FILL_RESULTS_DIR),
    requiredStoreActivityCount: required.keys.size,
    requiredActivityCount: required.activities.size,
    foundStoreActivityCount: byStoreActivity.size,
    foundActivityCount: byActivity.size,
    missingStoreActivityKeys,
    inspected: inspected.slice(0, 80),
    byStoreActivity,
    byActivity,
  };
}

function resolvePlanWindow(row, activityWindowEvidence) {
  const rowStart = row?.planStartTime || row?.activityStartTime || row?.eventStart || '';
  const rowEnd = row?.planEndTime || row?.activityEndTime || row?.eventEnd || '';
  let start = rowStart;
  let end = rowEnd;
  let source = start || end ? 'price_overrides_row' : '';
  const storeKey = normKey(row?.storeKey || row?.store || row?.['店铺']);
  const activityId = String(row?.activityId || row?.['活动ID'] || '').trim();
  if ((!start || !end) && activityWindowEvidence) {
    const byStore = activityWindowEvidence.byStoreActivity?.get(planActivityKey(storeKey, activityId));
    const byActivity = activityWindowEvidence.byActivity?.get(activityId);
    const window = byStore || byActivity || null;
    if (window) {
      start = start || window.eventStart;
      end = end || window.eventEnd;
      source = byStore ? 'deadline_fill_store_activity' : 'deadline_fill_activity_fallback';
    }
  }
  const startDate = parseAnyDateTime(start);
  const endDate = parseAnyDateTime(end);
  return {
    hasPlanWindow: Boolean(start && end && startDate && endDate),
    planStartTime: start || '',
    planEndTime: end || '',
    planStartMs: startDate ? startDate.getTime() : null,
    planEndMs: endDate ? endDate.getTime() : null,
    activityWindowSource: source,
  };
}

function selectOrderPlanRow(candidateRows, orderTime) {
  const candidates = Array.isArray(candidateRows) ? candidateRows : [];
  if (!candidates.length) return {status: 'missing_plan', planRow: null};
  const withWindows = candidates.filter(row => row?.hasPlanWindow && Number.isFinite(row.planStartMs) && Number.isFinite(row.planEndMs));
  const missingWindow = candidates.filter(row => !row?.hasPlanWindow);
  const orderDate = parseAnyDateTime(orderTime);
  if (withWindows.length && !orderDate) {
    return {status: 'missing_order_time_for_plan_window', planRow: withWindows[0], candidateCount: candidates.length};
  }
  if (withWindows.length && orderDate) {
    const orderMs = orderDate.getTime();
    const active = withWindows.filter(row => orderMs >= row.planStartMs && orderMs <= row.planEndMs);
    if (active.length) {
      active.sort((a, b) => {
        const priorityDiff = Number(a.sourcePriority ?? 50) - Number(b.sourcePriority ?? 50);
        if (priorityDiff) return priorityDiff;
        const av = Number(a.finalTargetPrice ?? Infinity);
        const bv = Number(b.finalTargetPrice ?? Infinity);
        if (av !== bv) return av - bv;
        return String(a.activityId || '').localeCompare(String(b.activityId || ''));
      });
      return {
        status: 'active_window',
        planRow: active[0],
        candidateCount: candidates.length,
        activeCandidateCount: active.length,
        duplicateResolution: active.length > 1 ? 'use_lowest_active_finalTargetPrice_same_time_window' : '',
      };
    }
    withWindows.sort((a, b) => Number(a.planStartMs ?? Infinity) - Number(b.planStartMs ?? Infinity));
    return {status: 'outside_plan_window', planRow: withWindows[0], candidateCount: candidates.length};
  }
  if (missingWindow.length) return {status: 'missing_plan_window', planRow: missingWindow[0], candidateCount: candidates.length};
  return {status: 'missing_plan', planRow: candidates[0] || null, candidateCount: candidates.length};
}

function linkTargetRowsFromLinksData(linksDataDoc, linksDataSourcePath = '', activityWindowEvidence = null) {
  const data = unwrapBiLinksData(linksDataDoc);
  const linkRows = [
    ...(Array.isArray(data.storeLinks) ? data.storeLinks : []),
    ...(Array.isArray(data.links) ? data.links : []),
  ];
  const rows = [];
  for (const row of linkRows) {
    const storeKey = normKey(row?.store_key || row?.storeKey || row?.store);
    const skc = normSku(row?.skc || row?.SKC);
    const finalTargetPrice = numberOrNull(row?.marketing_final_target_price_sar ?? row?.marketing_final_target_price ?? row?.finalTargetPrice);
    if (!storeKey || !skc || finalTargetPrice === null) continue;
    const item = {
      key: `${storeKey}::${skc}`,
      storeKey,
      skc,
      canonical: normSku(row?.standard_goods_sn || row?.standardGoodsSn || row?.canonical || row?.raw_goods_sn),
      activityId: row?.marketing_activity_id || row?.activityId || '',
      targetPrice: numberOrNull(row?.marketing_suggested_ordinary_price_sar ?? row?.targetPrice) ?? finalTargetPrice,
      finalTargetPrice,
      couponFactor: numberOrNull(row?.marketing_coupon_factor ?? row?.couponFactor),
      combo: row?.marketing_ordinary_summary || row?.marketing_coupon_summary || row?.combo || '',
      rule: row?.marketing_price_note || '',
      sourceCreatedAt: linksDataDoc?.generatedAt || data.generatedAt || '',
      sourceWorkbook: '',
      sourcePath: linksDataSourcePath,
      hasPlanWindow: false,
      planStartTime: '',
      planEndTime: '',
      planStartMs: null,
      planEndMs: null,
      activityWindowSource: 'linksData_exact_store_skc_current_target_overlay',
      sourceType: 'linksData_exact_store_skc_current_target',
      sourcePriority: 0,
      linkStatus: row?.shelf_status_name || row?.visible_shelf_statuses || '',
      newListingTopTreatment: row?.newListingTopTreatment === true || /新上架|新品|New\s*Arrivals/i.test(String(row?.marketing_price_note || row?.performance_activity_names || '')),
      priceEvidenceType: row?.marketing_price_evidence_type || '',
    };
    const window = resolvePlanWindow(item, activityWindowEvidence);
    rows.push({
      ...item,
      ...window,
      activityWindowSource: window.activityWindowSource || item.activityWindowSource,
    });
  }
  return rows;
}

function buildOrderTargetPlanIndex(priceOverridesDoc, priceOverridesSourcePath = '', activityWindowEvidence = null, linksDataDoc = null, linksDataSourcePath = '') {
  const bySkc = new Map();
  const rowsBySkc = new Map();
  const duplicateKeys = [];
  const duplicateConflicts = [];
  const missingTargetRows = [];
  const linkTargetRows = linkTargetRowsFromLinksData(linksDataDoc, linksDataSourcePath, activityWindowEvidence);
  const linkTargetBySkc = new Map(linkTargetRows.map(row => [row.key, row]));
  const addItem = item => {
    const key = item.key;
    const finalTargetPrice = item.finalTargetPrice;
    if (!rowsBySkc.has(key)) rowsBySkc.set(key, []);
    rowsBySkc.get(key).push(item);
    if (finalTargetPrice === null) missingTargetRows.push({
      storeKey: item.storeKey,
      skc: item.skc,
      canonical: item.canonical,
      reason: 'missing_finalTargetPrice',
    });
    if (bySkc.has(key)) {
      duplicateKeys.push(key);
      const existing = bySkc.get(key);
      const priceDiffers = Math.abs(Number(existing.finalTargetPrice ?? NaN) - Number(item.finalTargetPrice ?? NaN)) > 0.01;
      const couponDiffers = Math.abs(Number(existing.couponFactor ?? NaN) - Number(item.couponFactor ?? NaN)) > 0.001;
      const sourcePriorityDiffers = Number(existing.sourcePriority ?? 50) !== Number(item.sourcePriority ?? 50);
      // P2-#7: only report as conflict if same activityId has different price.
      // Same SKC in different activities (e.g. 46353 vs 46354) with different prices
      // is expected, not a conflict.
      const sameActivity = String(existing.activityId || '') === String(item.activityId || '');
      if ((priceDiffers || couponDiffers) && sameActivity) {
        duplicateConflicts.push({
          key,
          existing: {
            activityId: existing.activityId,
            finalTargetPrice: existing.finalTargetPrice,
            couponFactor: existing.couponFactor,
            combo: existing.combo,
          },
          duplicate: {
            activityId: item.activityId,
            finalTargetPrice: item.finalTargetPrice,
            couponFactor: item.couponFactor,
            combo: item.combo,
          },
          decision: 'use_conservative_highest_finalTargetPrice',
        });
      }
      const replacement = (
        Number(item.sourcePriority ?? 50) < Number(existing.sourcePriority ?? 50)
          ? {...item, duplicateResolution: 'use_exact_linksData_current_target'}
          : (
            item.finalTargetPrice !== null
            && (existing.finalTargetPrice === null || item.finalTargetPrice > existing.finalTargetPrice)
            && !sourcePriorityDiffers
          )
          ? {...item, duplicateResolution: 'use_conservative_highest_finalTargetPrice'}
          : null
      );
      if (replacement) {
        bySkc.set(key, replacement);
      }
      return;
    }
    bySkc.set(key, item);
  };
  for (const row of priceOverridesDoc?.items || []) {
    const key = planItemKey(row);
    if (!key || key.endsWith('::')) continue;
    const window = resolvePlanWindow(row, activityWindowEvidence);
    // A submitted/approved plan with a real activity window is immutable for
    // order auditing. Daily linksData exposure changes are inputs to the next
    // plan, not retroactive replacements for the currently executing target.
    const linkTarget = window.hasPlanWindow ? null : (linkTargetBySkc.get(key) || null);
    const planFinalTargetPrice = numberOrNull(row?.finalTargetPrice);
    addItem({
      key,
      storeKey: normKey(row?.storeKey || row?.store || row?.['店铺']),
      skc: normSku(row?.skc || row?.SKC || row?.['SKC']),
      canonical: normSku(row?.canonical || row?.standard_goods_sn || row?.standardGoodsSn || row?.['标准货号']),
      activityId: row?.activityId || '',
      targetPrice: linkTarget?.targetPrice ?? numberOrNull(row?.targetPrice),
      finalTargetPrice: linkTarget?.finalTargetPrice ?? planFinalTargetPrice,
      couponFactor: linkTarget?.couponFactor ?? numberOrNull(row?.couponFactor),
      combo: linkTarget?.combo || row?.combo || '',
      rule: linkTarget?.rule || row?.rule || '',
      sourceCreatedAt: priceOverridesDoc?.createdAt || '',
      sourceWorkbook: priceOverridesDoc?.sourceWorkbook || '',
      sourcePath: priceOverridesSourcePath,
      sourceType: linkTarget ? 'price_overrides_plan_with_linksData_exact_store_skc_target' : 'price_overrides_plan',
      sourcePriority: linkTarget ? 0 : 50,
      originalPlanFinalTargetPrice: linkTarget ? planFinalTargetPrice : null,
      linkTargetSourcePath: linkTarget?.sourcePath || '',
      linkTargetSourceCreatedAt: linkTarget?.sourceCreatedAt || '',
      linkTargetNote: linkTarget?.rule || '',
      ...window,
    });
  }
  for (const row of linkTargetRows) {
    if (!rowsBySkc.has(row.key)) addItem(row);
  }
  return {
    sourceCreatedAt: priceOverridesDoc?.createdAt || '',
    sourceWorkbook: priceOverridesDoc?.sourceWorkbook || '',
    sourcePath: priceOverridesSourcePath,
    rows: Array.isArray(priceOverridesDoc?.items) ? priceOverridesDoc.items.length : 0,
    linkTargetRows: linkTargetRows.length,
    bySkc,
    rowsBySkc,
    duplicateKeys,
    duplicateConflicts,
    missingTargetRows,
    activityWindowEvidence: activityWindowEvidence
      ? {
          status: activityWindowEvidence.status,
          sourceDir: activityWindowEvidence.sourceDir,
          requiredStoreActivityCount: activityWindowEvidence.requiredStoreActivityCount,
          requiredActivityCount: activityWindowEvidence.requiredActivityCount,
          foundStoreActivityCount: activityWindowEvidence.foundStoreActivityCount,
          foundActivityCount: activityWindowEvidence.foundActivityCount,
          missingStoreActivityKeys: activityWindowEvidence.missingStoreActivityKeys.slice(0, 50),
          inspected: activityWindowEvidence.inspected.slice(0, 30),
        }
      : null,
  };
}

function orderLineTime(row) {
  return row.orderCustomerTime || row.orderCreateTime || row.allocateTimeFull || row.allocateTime || '';
}

function loadOrderPriceMitigationEvidence(reportDate) {
  const mitigatedBySkc = new Map();
  const evidenceFiles = [];
  const add = (storeKey, skc, evidence) => {
    const key = `${normKey(storeKey)}::${normSku(skc)}`;
    if (!key || key === '::') return;
    const atMs = parseAnyDateTime(evidence.mitigatedAt || evidence.createdAt)?.getTime() ?? null;
    const current = mitigatedBySkc.get(key);
    if (!current || (atMs !== null && (current.mitigatedAtMs === null || atMs > current.mitigatedAtMs))) {
      mitigatedBySkc.set(key, {...evidence, mitigatedAtMs: atMs});
    }
  };

  const endDir = path.join(MARKETING_SIGNUP_DIR, 'limited-discount-end-results');
  for (const file of listFiles(endDir, /^limited-discount-end-execute-.*\.json$/)) {
    const doc = readJsonSafe(file);
    if (!doc) continue;
    evidenceFiles.push(rel(file));
    const createdAt = doc.createdAt || '';
    for (const store of doc.stores || []) {
      const storeKey = store.storeKey || '';
      for (const activity of store.activities || []) {
        for (const skc of activity.targetSkcs || []) {
          add(storeKey, skc, {
            type: 'limited_discount_ended',
            source: rel(file),
            mitigatedAt: createdAt,
            activityId: activity.activity_id || '',
            activityName: activity.act_name || '',
          });
        }
      }
      for (const activity of store.ended || []) {
        for (const skc of activity.targetSkcs || []) {
          add(storeKey, skc, {
            type: 'limited_discount_ended',
            source: rel(file),
            mitigatedAt: createdAt,
            activityId: activity.activity_id || '',
          });
        }
      }
    }
  }

  const fallbackStatusPath = path.join(DEFAULT_OUT_DIR, `coupon-non-guaranteed-limited-fallback-status-${reportDate}.json`);
  const fallbackStatus = readJsonSafe(fallbackStatusPath);
  if (fallbackStatus) {
    evidenceFiles.push(rel(fallbackStatusPath));
    for (const row of fallbackStatus.successRowsDetail || []) {
      add(row.storeKey, row.skc, {
        type: 'limited_discount_fallback_created',
        source: rel(fallbackStatusPath),
        mitigatedAt: fallbackStatus.createdAt || '',
        activityId: row.activityId || '',
        limitedDiscountPrice: row.limitedDiscountPrice ?? null,
      });
    }
  }

  const driftResultDirs = [
    DEFAULT_OUT_DIR,
    path.join(MARKETING_SIGNUP_DIR, 'limited-discount-rescue'),
  ];
  for (const dir of driftResultDirs) {
    for (const file of listFiles(dir, DRIFT_FIX_RESULT_FILE_PATTERN)) {
      if (!isDriftFixResultEligibleForReport(path.basename(file), reportDate)) continue;
      const doc = readJsonSafe(file);
      if (!doc) continue;
      evidenceFiles.push(rel(file));
      const mitigatedAt = doc.finishedAt || doc.updatedAt || doc.createdAt || '';
      for (const result of doc.results || []) {
        if (!result?.ok) continue;
        const repairedSkcs = new Set(
          result.readback?.ok
            ? (result.readback.overlapSkcs || []).map(String).filter(Boolean)
            : [],
        );
        const blockedBySkc = new Map((result.blockedSkcs || [])
          .map(row => [String(row?.skc || ''), row])
          .filter(([skc]) => skc));
        const successfullyRemoved = new Set((result.removals || [])
          .filter(item => !item?.skipped && item?.result?.ok)
          .flatMap(item => (item.skcs || []).map(String))
          .filter(Boolean));
        for (const skc of result.targetSkcs || []) {
          const normalizedSkc = String(skc || '');
          if (!normalizedSkc) continue;
          if (repairedSkcs.has(normalizedSkc)) {
            add(result.storeKey, normalizedSkc, {
              type: 'limited_discount_drift_repaired',
              source: rel(file),
              mitigatedAt,
              activityId: result.readback?.createdActivityId || '',
              sourceLimitedDiscountName: result.sourceLimitedDiscountName || '',
            });
          } else if (successfullyRemoved.has(normalizedSkc) && blockedBySkc.has(normalizedSkc)) {
            const blocked = blockedBySkc.get(normalizedSkc);
            add(result.storeKey, normalizedSkc, {
              type: 'limited_discount_drift_removed_platform_blocked',
              source: rel(file),
              mitigatedAt,
              sourceLimitedDiscountName: result.sourceLimitedDiscountName || '',
              platformErrorCode: blocked?.error_code || '',
              platformReason: blocked?.reason || '',
            });
          }
        }
      }
    }
  }

  return {
    status: mitigatedBySkc.size ? 'ok' : 'empty',
    mitigatedBySkc,
    evidenceFiles: [...new Set(evidenceFiles)],
  };
}

function summarizeCloudOrderPriceAudit({cloudRowsDoc, priceOverridesDoc, priceOverridesSourcePath, activityWindowEvidence, orderMitigationEvidence, manualLimitedDiscountRegistry, ordinaryPlatformTierIndex, now, maxAgeHours, linksDataDoc = null, linksDataSourcePath = ''}) {
  const plan = buildOrderTargetPlanIndex(priceOverridesDoc, priceOverridesSourcePath, activityWindowEvidence, linksDataDoc, linksDataSourcePath);
  const statusCounts = {};
  const byStore = {};
  const rows = [];
  const belowRows = [];
  const mitigatedBelowRows = [];
  const aboveRows = [];
  const dataQualityRows = [];
  const unmatchedRows = [];
  const missingFiles = [];
  const parseErrorFiles = [];
  const sourceMismatchFiles = [];
  const staleFiles = [];
  const duplicateRows = [];
  const seenOrderLineKeys = new Set();
  let cloudFiles = 0;
  let cloudRows = 0;
  let matchedPlanRows = 0;
  let fetchTimeMin = '';
  let fetchTimeMax = '';
  const sourceFiles = [];
  const addStatus = status => {
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  };
  const addByStore = (storeKey, status) => {
    if (!storeKey) return;
    const item = byStore[storeKey] || {rows: 0, below: 0, above: 0, outsideWindow: 0, unmatched: 0, missingPlan: 0, missingPlanWindow: 0, grainUnknown: 0, dataQuality: 0};
    item.rows += 1;
    if (status === 'below_target') item.below += 1;
    if (status === 'above_target') item.above += 1;
    if (status === 'outside_plan_window') item.outsideWindow += 1;
    if (status === 'missing_plan') item.missingPlan += 1;
    if (status === 'missing_plan_window') item.missingPlanWindow += 1;
    if (status === 'unmatched_plan') item.unmatched += 1;
    if (status === 'grain_unknown') item.grainUnknown += 1;
    if (!['matches_target', 'below_target', 'above_target', 'outside_plan_window', 'unmatched_plan', 'invalid_sale_ignored'].includes(status)) item.dataQuality += 1;
    byStore[storeKey] = item;
  };

  for (const file of cloudRowsDoc?.files || []) {
    const remotePath = file.remotePath || '';
    sourceFiles.push({
      storeKey: file.storeKey,
      date: file.date,
      path: remotePath ? `ssh:${cloudRowsDoc.host || ''}:${remotePath}` : '',
      exists: file.exists === true,
      ok: file.ok === true,
      rowCount: Number(file.rowCount || 0),
      fetchTime: file.fetchTime || '',
      error: file.error || '',
    });
    if (file.exists !== true) {
      missingFiles.push({storeKey: file.storeKey, date: file.date, path: remotePath});
      continue;
    }
    if (file.ok !== true) {
      parseErrorFiles.push({storeKey: file.storeKey, date: file.date, path: remotePath, error: file.error || 'parse_error'});
      continue;
    }
    cloudFiles += 1;
    const docStoreKey = normKey(file.docStoreKey || file.storeKey);
    const expectedStoreKey = normKey(file.storeKey);
    if (!file.docStoreKey) {
      sourceMismatchFiles.push({
        storeKey: file.storeKey,
        date: file.date,
        path: remotePath,
        reason: 'missing doc.storeKey',
      });
    } else if (docStoreKey && expectedStoreKey && docStoreKey !== expectedStoreKey) {
      sourceMismatchFiles.push({
        storeKey: file.storeKey,
        date: file.date,
        path: remotePath,
        docStoreKey: file.docStoreKey,
        reason: 'doc.storeKey does not match path store',
      });
    }
    if (!file.start) {
      sourceMismatchFiles.push({
        storeKey: file.storeKey,
        date: file.date,
        path: remotePath,
        reason: 'missing doc.start',
      });
    } else if (String(file.start || '').slice(0, 10) !== file.date) {
      sourceMismatchFiles.push({
        storeKey: file.storeKey,
        date: file.date,
        path: remotePath,
        start: file.start || '',
        reason: 'doc.start does not match path date',
      });
    }
    const fetchTimeDate = parseAnyDateTime(file.fetchTime);
    if (file.fetchTime) {
      if (!fetchTimeMin || String(file.fetchTime) < fetchTimeMin) fetchTimeMin = String(file.fetchTime);
      if (!fetchTimeMax || String(file.fetchTime) > fetchTimeMax) fetchTimeMax = String(file.fetchTime);
    }
    const fileAgeHours = fetchTimeDate ? ageHours(now, fetchTimeDate) : null;
    if (!fetchTimeDate || (Number.isFinite(fileAgeHours) && fileAgeHours > maxAgeHours)) {
      staleFiles.push({
        storeKey: file.storeKey,
        date: file.date,
        path: remotePath,
        fetchTime: file.fetchTime || '',
        ageHours: fileAgeHours,
        reason: fetchTimeDate ? 'fetchTime exceeds maxAgeHours' : 'missing_or_invalid_fetchTime',
      });
    }
    for (const raw of file.rows || []) {
      const storeKey = normKey(raw.storeKey || file.storeKey);
      const skc = normSku(raw.skc || raw.skcName);
      const price = numberOrNull(raw.currencyPrice);
      const quantity = numberOrNull(raw.number ?? raw.quantity);
      const currencyCode = String(raw.currencyCode || raw.currency || '').trim() || 'SAR';
      const orderNo = String(raw.orderNo || raw.billno || '').trim();
      const canonical = normSku(raw.goodsSn || raw.canonical || raw.standard_goods_sn);
      const lineKey = [
        storeKey,
        orderNo || raw.orderId || '',
        skc,
        raw.entityId || raw.goodsId || raw.skuCode || raw.skuSn || '',
        raw.suffix || '',
        price === null ? '' : price,
      ].join('::');
      if (lineKey && seenOrderLineKeys.has(lineKey)) {
        duplicateRows.push({storeKey, date: raw.date || file.date, orderNo, skc, skuCode: raw.skuCode || '', currencyPrice: price});
        continue;
      }
      if (lineKey) seenOrderLineKeys.add(lineKey);
      cloudRows += 1;
      const isValidSale = raw.isValidSale;
      let status = 'matches_target';
      let reason = '';
      let finalTargetPrice = null;
      let deltaSar = null;
      let planRow = null;
      let selectedPlan = {planRow: null, status: '', duplicateResolution: ''};
      let planWindowStatus = '';
      let expectedPriceSource = 'ordinary_marketing_plan';
      let platformTierEntry = null;
      const orderTime = orderLineTime(raw);
      let manualSpecialEntry = null;
      if (!storeKey || !skc) {
        status = 'missing_store_or_skc';
        reason = '订单商品行缺店铺或 SKC，不能匹配目标价';
      } else if (isValidSale === false || String(isValidSale).toLowerCase() === 'false') {
        status = 'invalid_sale_ignored';
        reason = raw.salesExclusionReason || 'isValidSale=false';
      } else {
        const planKey = `${storeKey}::${skc}`;
        const planCandidates = plan.rowsBySkc.get(planKey) || [];
        manualSpecialEntry = findActiveManualLimitedDiscount(manualLimitedDiscountRegistry, storeKey, skc, orderTime || now);
        selectedPlan = selectOrderPlanRow(planCandidates, orderTime);
        planRow = selectedPlan.planRow || plan.bySkc.get(planKey) || null;
        planWindowStatus = selectedPlan.status || '';
        platformTierEntry = findActiveOrdinaryPlatformTier(ordinaryPlatformTierIndex, {
          storeKey,
          skc,
          activityId: planRow?.activityId,
          at: orderTime || now,
        });
        if (
          platformTierEntry
          && planRow?.finalTargetPrice !== null
          && platformTierEntry.platformTierPrice >= Number(planRow.finalTargetPrice) - 0.01
        ) {
          platformTierEntry = null;
        }
        if (manualSpecialEntry) {
          expectedPriceSource = 'manual_special_limited_discount_override';
          if (price === null) {
            status = 'missing_currency_price';
            reason = '命中人工特殊限时折扣窗口，但订单商品行缺 currencyPrice';
          } else if (currencyCode !== 'SAR') {
            status = 'unsupported_currency';
            reason = `命中人工特殊限时折扣窗口，但币种为 ${currencyCode}，暂不能按 SAR 特殊价比较`;
          } else if (quantity !== null && quantity !== 1) {
            status = 'grain_unknown';
            reason = `命中人工特殊限时折扣窗口，但 number=${quantity}，不能确认 currencyPrice 是否单件成交价`;
          } else {
            matchedPlanRows += 1;
            finalTargetPrice = manualSpecialEntry.specialPrice;
            deltaSar = Math.round((price - finalTargetPrice) * 100) / 100;
            planWindowStatus = 'manual_special_limited_discount_window';
            if (deltaSar < -ORDER_PRICE_TOLERANCE_SAR) {
              status = 'below_target';
              reason = '订单商品行成交价低于用户批准的人工特殊限时折扣价';
            } else if (deltaSar > ORDER_PRICE_TOLERANCE_SAR) {
              status = 'above_target';
              reason = '订单商品行成交价高于用户批准的人工特殊限时折扣价';
            } else {
              status = 'matches_target';
              reason = '订单商品行成交价命中用户批准的人工特殊限时折扣价';
            }
          }
        } else if (!planCandidates.length) {
          status = 'unmatched_plan';
          reason = '不在 price-overrides 精确目标价计划内；仅做背景计数，不参与低价/高价结论';
        } else if (selectedPlan.status === 'outside_plan_window') {
          status = 'outside_plan_window';
          reason = '订单时间不在当前已执行活动目标价生效窗口内；只作历史线索，不参与低价/高价结论';
        } else if (selectedPlan.status === 'missing_plan_window') {
          status = 'missing_plan_window';
          reason = '命中目标价计划，但缺活动生效窗口证据；不能把历史订单静默按当前目标比价';
        } else if (selectedPlan.status === 'missing_order_time_for_plan_window') {
          status = 'missing_order_time_for_plan_window';
          reason = '命中带活动窗口的目标价计划，但订单商品行缺订单时间；不能判断是否在活动窗口内';
        } else if (planRow.finalTargetPrice === null) {
          status = 'missing_final_target_price';
          reason = 'price-overrides 精确行缺 finalTargetPrice';
        } else if (price === null) {
          status = 'missing_currency_price';
          reason = '命中目标价计划，但订单商品行缺 currencyPrice';
        } else if (currencyCode !== 'SAR') {
          status = 'unsupported_currency';
          reason = `命中目标价计划，但币种为 ${currencyCode}，暂不能按 SAR 目标价比较`;
        } else if (quantity !== null && quantity !== 1) {
          status = 'grain_unknown';
          reason = `命中目标价计划，但 number=${quantity}，不能确认 currencyPrice 是否单件成交价`;
        } else {
          matchedPlanRows += 1;
          finalTargetPrice = platformTierEntry?.platformTierPrice ?? planRow.finalTargetPrice;
          if (platformTierEntry) expectedPriceSource = 'ordinary_platform_forced_minimum_tier';
          deltaSar = Math.round((price - finalTargetPrice) * 100) / 100;
          if (deltaSar < -ORDER_PRICE_TOLERANCE_SAR) {
            status = 'below_target';
            reason = platformTierEntry
              ? '订单商品行成交价低于平台强制最低档'
              : '订单商品行成交价低于 finalTargetPrice';
            const mitigation = orderMitigationEvidence?.mitigatedBySkc?.get(`${storeKey}::${skc}`) || null;
            const orderAtMs = parseAnyDateTime(orderTime)?.getTime() ?? null;
            if (mitigation?.mitigatedAtMs !== null && mitigation?.mitigatedAtMs !== undefined && orderAtMs !== null && orderAtMs <= mitigation.mitigatedAtMs) {
              status = 'below_target_mitigated_before_or_at_fix';
              reason = '订单商品行成交价低于目标，但订单时间早于/不晚于已验证止损动作；作为历史线索继续观察，不作为当前 blocker';
            }
          } else if (deltaSar > ORDER_PRICE_TOLERANCE_SAR) {
            status = 'above_target';
            reason = platformTierEntry
              ? '订单商品行成交价高于平台强制最低档'
              : '订单商品行成交价高于 finalTargetPrice';
          } else if (platformTierEntry) {
            reason = '订单商品行成交价命中用户已授权的平台强制最低档';
          }
        }
      }
      addStatus(status);
      addByStore(storeKey, status);
      const outRow = {
        source: 'cloud_shein_fetch_goodsRows',
        storeKey,
        date: raw.date || file.date,
        orderNo,
        billno: raw.billno || orderNo,
        orderTime,
        skc,
        canonical: planRow?.canonical || canonical,
        goodsSn: canonical,
        skuCode: raw.skuCode || '',
        skuSn: raw.skuSn || '',
        suffix: raw.suffix || '',
        sourcePath: remotePath ? `ssh:${cloudRowsDoc.host || ''}:${remotePath}` : '',
        number: quantity,
        currencyPrice: price,
        actualUnitPriceUsed: quantity === null || quantity === 1 ? price : null,
        currencyCode,
        finalTargetPrice,
        ordinaryPlanFinalTargetPrice: planRow?.finalTargetPrice ?? null,
        expectedPriceSource,
        platformTierPrice: platformTierEntry?.platformTierPrice ?? null,
        platformTierApprovedTargetPrice: platformTierEntry?.approvedTargetPrice ?? null,
        platformTierActivityId: platformTierEntry?.activityId ?? null,
        platformTierValidFrom: platformTierEntry?.validFrom || '',
        platformTierValidTo: platformTierEntry?.validTo || '',
        platformTierEvidenceSource: platformTierEntry?.sourcePath || '',
        manualSpecialPrice: manualSpecialEntry?.specialPrice ?? null,
        manualSpecialValidFrom: manualSpecialEntry?.validFrom || '',
        manualSpecialValidTo: manualSpecialEntry?.validTo || '',
        targetPrice: planRow?.targetPrice ?? null,
        couponFactor: planRow?.couponFactor ?? null,
        deltaSar,
        toleranceSar: ORDER_PRICE_TOLERANCE_SAR,
        activityId: planRow?.activityId || '',
        combo: planRow?.combo || '',
        duplicateResolution: selectedPlan.duplicateResolution || planRow?.duplicateResolution || '',
        planSourcePath: planRow?.sourcePath || priceOverridesSourcePath,
        planSourceCreatedAt: planRow?.sourceCreatedAt || plan.sourceCreatedAt,
        targetPriceSource: planRow?.sourceType || planRow?.targetPriceSource || '',
        originalPlanFinalTargetPrice: planRow?.originalPlanFinalTargetPrice ?? null,
        linkTargetSourcePath: planRow?.linkTargetSourcePath || '',
        linkTargetNote: planRow?.linkTargetNote || '',
        planHasWindow: planRow?.hasPlanWindow === true,
        planStartTime: planRow?.planStartTime || '',
        planEndTime: planRow?.planEndTime || '',
        planWindowStatus,
        activityWindowSource: planRow?.activityWindowSource || '',
        status,
        reason,
        isValidSale,
        orderStatusDesc: raw.orderStatusDesc || '',
        performStatusDesc: raw.performStatusDesc || '',
        performanceTag: raw.performanceTag ?? null,
      };
      rows.push(outRow);
      if (status === 'below_target') belowRows.push(outRow);
      else if (status === 'below_target_mitigated_before_or_at_fix') mitigatedBelowRows.push(outRow);
      else if (status === 'above_target') aboveRows.push(outRow);
      else if (status === 'unmatched_plan') unmatchedRows.push(outRow);
      else if (!['matches_target', 'invalid_sale_ignored', 'outside_plan_window'].includes(status)) dataQualityRows.push(outRow);
    }
  }
  belowRows.sort((a, b) => Number(a.deltaSar ?? 0) - Number(b.deltaSar ?? 0));
  aboveRows.sort((a, b) => Number(b.deltaSar ?? 0) - Number(a.deltaSar ?? 0));
  dataQualityRows.sort((a, b) => String(a.storeKey).localeCompare(String(b.storeKey)) || String(a.orderTime).localeCompare(String(b.orderTime)));
  const samples = [
    ...belowRows,
    ...aboveRows,
    ...dataQualityRows,
    ...rows.filter(row => row.status === 'matches_target'),
  ].slice(0, 20);
  return {
    source: 'cloud_shein_fetch',
    status: cloudRowsDoc?.status || 'unknown',
    transport: cloudRowsDoc?.transport || 'ssh',
    host: cloudRowsDoc?.host || '',
    root: cloudRowsDoc?.root || '',
    dates: cloudRowsDoc?.dates || [],
    stores: cloudRowsDoc?.stores || [],
    lookbackDays: CLOUD_ORDER_LOOKBACK_DAYS,
    toleranceSar: ORDER_PRICE_TOLERANCE_SAR,
    planSourcePath: priceOverridesSourcePath,
    planSourceCreatedAt: plan.sourceCreatedAt,
    planRows: plan.rows,
    duplicatePlanKeys: plan.duplicateKeys.slice(0, 30),
    duplicatePlanConflictCount: plan.duplicateConflicts.length,
    duplicatePlanConflicts: plan.duplicateConflicts.slice(0, 50),
    missingTargetPlanRows: plan.missingTargetRows.slice(0, 30),
    activityWindowEvidence: plan.activityWindowEvidence,
    orderMitigationEvidence: orderMitigationEvidence ? {
      status: orderMitigationEvidence.status,
      evidenceFiles: orderMitigationEvidence.evidenceFiles,
      mitigatedSkcCount: orderMitigationEvidence.mitigatedBySkc?.size || 0,
    } : null,
    expectedFiles: (cloudRowsDoc?.files || []).length,
    cloudFiles,
    readFiles: cloudFiles,
    missingFileCount: missingFiles.length,
    missingFiles: missingFiles.slice(0, 50),
    parseErrorFileCount: parseErrorFiles.length,
    parseErrorFiles: parseErrorFiles.slice(0, 20),
    sourceMismatchFileCount: sourceMismatchFiles.length,
    sourceMismatchFiles: sourceMismatchFiles.slice(0, 20),
    staleFileCount: staleFiles.length,
    staleFiles: staleFiles.slice(0, 20),
    fetchTimeMin,
    fetchTimeMax,
    duplicateRowCount: duplicateRows.length,
    duplicateRows: duplicateRows.slice(0, 20),
    sourceFiles: sourceFiles.slice(0, 80),
    rows: cloudRows,
    auditedRows: rows.length,
    matchedPlanRows,
    unmatchedRows: unmatchedRows.length,
    unmatchedSamples: unmatchedRows.slice(0, 30),
    below: statusCounts.below_target || 0,
    mitigatedBelow: statusCounts.below_target_mitigated_before_or_at_fix || 0,
    above: statusCounts.above_target || 0,
    outsideWindow: statusCounts.outside_plan_window || 0,
    missingPlan: 0,
    missingPlanWindow: statusCounts.missing_plan_window || 0,
    missingOrderTimeForPlanWindow: statusCounts.missing_order_time_for_plan_window || 0,
    missingFinalTargetPrice: statusCounts.missing_final_target_price || 0,
    missingPrice: statusCounts.missing_currency_price || 0,
    grainUnknown: statusCounts.grain_unknown || 0,
    unsupportedCurrency: statusCounts.unsupported_currency || 0,
    invalidSaleIgnored: statusCounts.invalid_sale_ignored || 0,
    dataQualityRows: dataQualityRows.length,
    statusCounts,
    byStore,
    belowRows: belowRows.slice(0, 200),
    mitigatedBelowRows: mitigatedBelowRows.slice(0, 200),
    aboveRows: aboveRows.slice(0, 200),
    dataQualitySamples: dataQualityRows.slice(0, 200),
    samples,
    allRows: rows,
    error: cloudRowsDoc?.error || '',
  };
}

function buildOrderPriceAuditFromCloud(cloudAudit) {
  return {
    source: 'cloud_shein_fetch',
    status: cloudAudit.status,
    files: Number(cloudAudit.cloudFiles || 0),
    rows: Number(cloudAudit.rows || 0),
    auditedRows: Number(cloudAudit.auditedRows || 0),
    matchedPlanRows: Number(cloudAudit.matchedPlanRows || 0),
    unmatchedRows: Number(cloudAudit.unmatchedRows || 0),
    below: Number(cloudAudit.below || 0),
    mitigatedBelow: Number(cloudAudit.mitigatedBelow || 0),
    above: Number(cloudAudit.above || 0),
    outsideWindow: Number(cloudAudit.outsideWindow || 0),
    grainUnknown: Number(cloudAudit.grainUnknown || 0),
    missingPlan: 0,
    missingPlanWindow: Number(cloudAudit.missingPlanWindow || 0),
    missingOrderTimeForPlanWindow: Number(cloudAudit.missingOrderTimeForPlanWindow || 0),
    missingFinalTargetPrice: Number(cloudAudit.missingFinalTargetPrice || 0),
    missingPrice: Number(cloudAudit.missingPrice || 0),
    unsupportedCurrency: Number(cloudAudit.unsupportedCurrency || 0),
    dataQualityRows: Number(cloudAudit.dataQualityRows || 0),
    statusCounts: {...(cloudAudit.statusCounts || {})},
    samples: [
      ...(cloudAudit.belowRows || []),
      ...(cloudAudit.aboveRows || []),
      ...(cloudAudit.mitigatedBelowRows || []),
      ...(cloudAudit.dataQualitySamples || []),
      ...(cloudAudit.samples || []),
    ].slice(0, 30),
    mitigatedBelowRows: cloudAudit.mitigatedBelowRows || [],
    cloud: cloudAudit,
  };
}

function selectMarketingStackReviewFile(storesConfigDoc) {
  const files = listFiles(path.join(ROOT, 'outputs', 'reports'), /^marketing-stack-review-\d{4}-\d{2}-\d{2}\.json$/);
  const inspected = [];
  let fallback = files[0] || '';
  for (const file of files.slice(0, 20)) {
    let doc = null;
    try {
      doc = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    } catch (err) {
      inspected.push({path: rel(file), status: 'parse_error', error: err.message});
      continue;
    }
    const coverage = summarizeStackReviewCoverage(doc, storesConfigDoc);
    inspected.push({
      path: rel(file),
      coverageComplete: coverage.coverageComplete,
      selectedStoreCount: coverage.selectedStoreCount,
      enabledStoreCount: coverage.enabledStoreCount,
      completedStoreCount: coverage.completedStoreCount,
      missingStores: coverage.missingStores,
    });
    if (coverage.coverageComplete) {
      return {
        file,
        selectedPath: rel(file),
        selectionReason: 'latest_complete_enabled_store_coverage',
        inspected: inspected.slice(0, 10),
        skippedNewerIncomplete: inspected.filter(item => item.path !== rel(file) && item.coverageComplete === false).slice(0, 10),
      };
    }
    if (!fallback) fallback = file;
  }
  return {
    file: fallback,
    selectedPath: rel(fallback),
    selectionReason: fallback ? 'fallback_latest_no_complete_coverage' : 'missing',
    inspected: inspected.slice(0, 10),
    skippedNewerIncomplete: [],
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
  if (/(cancel_coupon_extra_goods|set_coupon_site_budget|end_limited_discounts_for_coupon_plan)\.mjs/.test(c)) {
    violations.push('write-capable script is not allowed as a suggested command');
  }
  if (/apply_hl_limited_discount_rescue\.mjs/.test(c) && !/--dry-run/.test(c)) {
    violations.push('apply_hl_limited_discount_rescue.mjs suggestion must be dry-run only');
  }
  return violations;
}

function optionalTrafficCouponReviewStatus({couponEligibilityPlan}) {
  const allowed15TrafficCount = (couponEligibilityPlan?.summary || [])
    .reduce((sum, row) => sum + Number(row.allowed15Traffic || 0), 0);
  return {
    name: 'optional_traffic_coupon_review_window',
    open: allowed15TrafficCount > 0,
    allowed15TrafficCount,
    reason: allowed15TrafficCount > 0
      ? '当前计划存在明确可选流量券目标；只允许生成 dry-run 给用户确认，禁止把优惠券作为价格保障补回。'
      : '当前计划没有明确可选流量券目标；价格保障不能依赖优惠券，禁止生成补券执行建议。',
  };
}

function buildDryRunCommands({targetPlan, priceOverrides, optionalTrafficCouponReview, couponEligibilityPlan, newSkcCandidates, limitedDiscountTargetPriceDrift, reportDate = ''}) {
  const commands = [];
  if (Number(limitedDiscountTargetPriceDrift?.belowTarget || 0) > 0) {
    commands.push({
      label: 'limited-discount-target-drift-build-rescue-plan',
      command: `node scripts/marketing/build_limited_discount_drift_rescue_plan.mjs --guard outputs/reports/marketing-daily-guard-${reportDate || new Date().toISOString().slice(0, 10)}.json --activity-name-prefix "限时折扣目标价漂移修复"`,
      nextAfterPass: '生成 rescue 文件后，按店铺/旧活动先运行 apply_hl_limited_discount_rescue.mjs --dry-run；单一目标活动安全通过后才允许 execute，混合活动必须 fail-closed 后走 split-preserve。',
    });
  }
  const newListing = newSkcCandidates?.newListingWithin7DaysLimitedDiscount || {};
  const newListingFiles = Array.isArray(newListing?.rescueFiles)
    ? newListing.rescueFiles
    : [];
  if (Number(newListing.executableActionCount ?? newListing.actionCount ?? 0) > 0 && !newListingFiles.length) {
    const liveArg = newListing.liveLimitedDiscountSource ? ` --current-marketing-live-scan ${newListing.liveLimitedDiscountSource}` : '';
    commands.push({
      label: 'new-listing-limited-discount-build-plan',
      command: `node scripts/marketing/build_new_listing_limited_discount_plan.mjs --date ${reportDate || new Date().toISOString().slice(0, 10)} --price-overrides ${rel(priceOverrides)}${liveArg}`,
      nextAfterPass: '生成 rescue 文件后，先运行对应 apply_hl_limited_discount_rescue.mjs --dry-run；安全通过后才允许人工授权 execute 并回读。',
    });
  }
  for (const file of newListingFiles) {
    if (!file?.path || Number(file.count || 0) <= 0) continue;
    const endTimeArg = file.endTime ? ` --end-time ${doubleQuoteArg(file.endTime)}` : '';
    const activityNamePrefixArg = file.activityNamePrefix ? ` --activity-name-prefix ${doubleQuoteArg(file.activityNamePrefix)}` : '';
    commands.push({
      label: `new-listing-limited-discount-${file.storeKey}-dry-run`,
      command: `node scripts/marketing/apply_hl_limited_discount_rescue.mjs --store-key ${file.storeKey} --rescue ${file.path}${endTimeArg}${activityNamePrefixArg} --dry-run --no-close`,
      nextAfterPass: `安全通过并完成身份校验后，才可把同一命令改为 --execute；执行后必须回读并关闭 ${file.storeKey} 浏览器。`,
    });
  }
  if (!optionalTrafficCouponReview?.open) return commands;
  const allowed15TrafficCount = (couponEligibilityPlan?.summary || [])
    .reduce((sum, row) => sum + Number(row.allowed15Traffic || 0), 0);
  const allowed15Count = (couponEligibilityPlan?.summary || [])
    .reduce((sum, row) => sum + Number(row.allowed15 || 0), 0);
  if (allowed15TrafficCount <= 0 || allowed15Count <= 0) return commands;
  const storesConfig = JSON.parse(fsSync.readFileSync(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
  const allowedStores = new Set((couponEligibilityPlan?.summary || [])
    .filter(row => Number(row.allowed15Traffic || 0) > 0)
    .map(row => row.storeKey));
  const stores = (storesConfig.stores || [])
    .filter(s => s.enabled !== false && allowedStores.has(s.storeKey))
    .map(s => s.storeKey)
    .join(',');
  if (!stores) return commands;
  commands.push({
    label: 'optional-traffic-34810-15pct-coupon-dry-run',
    command: `node scripts/marketing/submit_coupon_activity_goods.mjs --stores ${stores} --activity-id 34810 --discount-max 15 --target-plan ${rel(targetPlan)} --price-overrides ${rel(priceOverrides)} --dry-run --no-close`,
  });
  return commands;
}

function summarizeCouponTrafficIntent(couponEligibilityPlan) {
  const summary = couponEligibilityPlan?.summary || [];
  const allowed15TrafficCount = summary.reduce((sum, row) => sum + Number(row.allowed15Traffic || 0), 0);
  const allowed15Count = summary.reduce((sum, row) => sum + Number(row.allowed15 || 0), 0);
  const stores = summary
    .filter(row => Number(row.allowed15Traffic || 0) > 0)
    .map(row => ({storeKey: row.storeKey, allowed15Traffic: Number(row.allowed15Traffic || 0)}));
  return {
    enabled: allowed15TrafficCount > 0,
    allowed15TrafficCount,
    allowed15Count,
    stores,
    note: allowed15TrafficCount > 0
      ? '当前计划存在明确可选流量券目标，预算证据会影响能否提交 34810/15% 券。'
      : '当前计划没有明确可选流量券目标；预算只作为观察项，不再阻塞价格止损。',
  };
}

function addBlocker(blockers, code, message, evidence = {}) {
  blockers.push({code, message, evidence});
}

function humanCount(value, unit = '个') {
  const n = Number(value || 0);
  return `${n} ${unit}`;
}

function humanPercent(value) {
  if (value === null || value === undefined || value === '') return '缺证据';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '缺证据';
}

function humanEffectStatus(value) {
  return ({
    converted: '已出单',
    observing_no_sale_yet: '活动中，暂未出单',
    ended_without_sale: '已到期，仍未出单',
    missing_current_metrics: '缺当前7日指标',
    pending: '待开始',
  })[String(value || '')] || String(value || '未知');
}

function humanWindowStatus(value) {
  return ({
    active: '进行中',
    ended: '已到期',
    pending: '待开始',
    invalid_window: '时间窗异常',
  })[String(value || '')] || String(value || '未知');
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
    orderPriceAudit: '订单商品行审计',
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

function reasonCountText(counts = {}, limit = 4) {
  const entries = Object.entries(counts || {})
    .filter(([, v]) => Number(v) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) return '';
  const shown = entries.slice(0, limit).map(([reason, count]) => `${count} 个：${reason}`).join('；');
  return entries.length > limit ? `${shown} 等 ${entries.length} 类` : shown;
}

function summarizeMandatoryLimitedDiscountStatus({liveScanSource, gapResultSource, fallbackGaps}) {
  const liveDoc = liveScanSource?.data || {};
  const liveStores = Array.isArray(liveDoc.stores) ? liveDoc.stores : [];
  const liveRows = Array.isArray(liveDoc.rows) ? liveDoc.rows : [];
  const liveOkStores = liveStores.filter(store => store?.ok).length;
  const liveFailedStores = liveStores.length ? liveStores.length - liveOkStores : 0;
  const limitedRows = liveRows.filter(row => row.marketing_limited_discount_price_sar !== undefined
    && row.marketing_limited_discount_price_sar !== null
    && row.marketing_limited_discount_price_sar !== '').length;
  const couponOnlyRows = liveRows.filter(row => String(row.marketing_price_evidence_type || '') === 'current_coupon_only_live_scan').length;

  const gapDoc = gapResultSource?.data || {};
  const repair = normalizeLimitedRepairResult(gapDoc);
  const {
    executedCount,
    blockedCount,
    initialGap,
    remainingGapByAfterScan,
    byStoreExec,
    byStoreBlocked,
    reasonSummary,
  } = repair;
  const fallbackTotal = Number(fallbackGaps?.total || 0);
  const fallbackByStore = fallbackGaps?.byStore || {};
  const fallbackByBucket = fallbackGaps?.byBucket || {};

  const liveEvidenceText = liveScanSource?.source?.status === 'ok'
    ? `今天已跑 SHEIN 后台 live scan，覆盖 ${liveOkStores}/${liveStores.length || 0} 店，读到当前限时折扣 ${humanCount(limitedRows, '行')}；不是只看 BI。`
    : '今天没有新鲜的 SHEIN 后台 live scan 证据，不能只凭 BI 判断限时折扣是否已报。';
  const autoRepairText = gapResultSource?.source?.exists
    ? `最近一次漏限时折扣处理：发现 ${humanCount(initialGap, '个')}缺口，安全自动补上 ${humanCount(executedCount, '个')}${storeCountText(byStoreExec, 6) ? `（${storeCountText(byStoreExec, 6)}）` : ''}，剩余 ${humanCount(blockedCount || remainingGapByAfterScan, '个')}未硬写。`
    : '还没有找到最近一次漏限时折扣补报结果文件。';
  const remainingText = (blockedCount || fallbackTotal)
    ? `剩余未报/未兜底主要是历史 live/dry-run 已确认的平台或库存阻断，不是正常放弃：${reasonCountText(reasonSummary, 4) || storeCountText(fallbackByBucket, 4) || '需要查看明细'}。按店铺看：${storeCountText(byStoreBlocked, 8) || storeCountText(fallbackByStore, 8) || '暂无店铺分布'}。`
    : '当前没有历史遗留的限时折扣兜底缺口。';
  const actionText = (blockedCount || fallbackTotal)
    ? '后续处理口径：库存/平台状态恢复后继续自动复扫；能 dry-run 通过的直接补，仍被平台拒绝的继续列阻断，不硬写。'
    : '后续处理口径：继续每日 live scan；发现新链接或漏兜底且校验安全时自动补。';

  return {
    live: {
      status: liveScanSource?.source?.status || 'missing',
      path: liveScanSource?.source?.path || '',
      createdAt: liveDoc.createdAt || liveDoc.generatedAt || '',
      ok: Boolean(liveDoc.ok),
      partial: Boolean(liveDoc.partial),
      storeCount: liveStores.length,
      okStoreCount: liveOkStores,
      failedStoreCount: liveFailedStores,
      rowCount: Number(liveDoc.rowCount || liveRows.length || 0),
      currentRows: Number(liveDoc.currentRows || 0),
      futureRows: Number(liveDoc.futureRows || 0),
      limitedRows,
      couponOnlyRows,
    },
    latestAutoRepair: {
      status: gapResultSource?.source?.status || 'missing',
      path: gapResultSource?.source?.path || '',
      createdAt: gapDoc.createdAt || '',
      initialGap,
      executedCount,
      blockedCount,
      remainingGapByAfterScan,
      afterLimitedRows: repair.afterLimitedRows,
      byStoreExec,
      byStoreBlocked,
      reasonSummary,
      executedSamples: repair.executedSamples,
      blockedSamples: repair.blockedSamples,
    },
    remainingLegacyFallback: {
      total: fallbackTotal,
      byStore: fallbackByStore,
      byBucket: fallbackByBucket,
      lowOrderHitCount: Number(fallbackGaps?.lowOrderHitCount || 0),
    },
    human: {
      liveEvidenceText,
      autoRepairText,
      remainingText,
      actionText,
    },
  };
}

function summarizeCouponNonGuaranteedFallbackGaps(sourceItem) {
  const data = sourceItem?.data;
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const byBucket = data?.byBucket && typeof data.byBucket === 'object'
    ? data.byBucket
    : rows.reduce((acc, row) => {
      const bucket = row.bucket || '未归类';
      acc[bucket] = (acc[bucket] || 0) + 1;
      return acc;
    }, {});
  const byStore = data?.byStore && typeof data.byStore === 'object'
    ? data.byStore
    : rows.reduce((acc, row) => {
      const store = row.storeKey || 'UNKNOWN';
      acc[store] = (acc[store] || 0) + 1;
      return acc;
    }, {});
  const lowOrderRows = Array.isArray(data?.lowOrderRows) ? data.lowOrderRows : [];
  return {
    status: sourceItem?.source?.status || 'missing',
    sourcePath: sourceItem?.source?.path || '',
    total: Number(data?.total ?? rows.length ?? 0),
    byBucket,
    byStore,
    lowOrderHitCount: lowOrderRows.length,
    lowOrderSamples: lowOrderRows.slice(0, 10),
    samples: rows.slice(0, 10).map(row => ({
      storeKey: row.storeKey || '',
      skc: row.skc || '',
      canonical: row.canonical || '',
      bucket: row.bucket || '',
      action: row.action || '',
      reason: row.reason || row.note || '',
    })),
  };
}

function summarizeOrdinaryEnrollmentOpenIssues(sourceItem) {
  const data = sourceItem?.data;
  const summary = data?.summary || {};
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const issueRows = rows.filter(row => {
    const enrolled = String(row.enrolledOrUnderReview || '').toLowerCase() === 'true' || row.enrolledOrUnderReview === true;
    const priceOk = String(row.priceOk || '').toLowerCase() === 'true' || row.priceOk === true;
    return !enrolled || !priceOk || row.issue || !row.fillEvidence;
  });
  return {
    status: sourceItem?.source?.status || 'missing',
    sourcePath: sourceItem?.source?.path || '',
    plannedRows: Number(summary.plannedRows || rows.length || 0),
    enrolledOrUnderReview: Number(summary.enrolledOrUnderReview || rows.filter(row => String(row.enrolledOrUnderReview || '').toLowerCase() === 'true' || row.enrolledOrUnderReview === true).length || 0),
    fillVerified: Number(summary.fillVerified || 0),
    platformAdjusted: Number(summary.platformAdjusted || 0),
    missingFillEvidence: Number(summary.missingFillEvidence || 0),
    issueCount: issueRows.length,
    issueRows: issueRows.slice(0, 20).map(row => ({
      storeKey: row.storeKey || '',
      activityId: row.activityId || '',
      skc: row.skc || '',
      canonical: row.canonical || '',
      expectedActivityPrice: row.expectedActivityPrice || '',
      actualActivityPrice: row.actualActivityPrice || '',
      issue: row.issue || '',
      state: row.state || '',
      hasFillEvidence: Boolean(row.fillEvidence),
    })),
  };
}

function summarizeOrdinaryEnrollmentSupplementOpenIssues(sourceItem) {
  const data = sourceItem?.data;
  const summary = data?.summary || {};
  return {
    status: sourceItem?.source?.status || 'missing',
    sourcePath: sourceItem?.source?.path || '',
    pricePendingRows: Number(summary.xcPricePendingRows || 0),
    extraAvailableRows: Number(summary.extraAvailableRows || 0),
    action: summary.action || '',
    pricePendingSamples: Array.isArray(data?.pricePendingRows) ? data.pricePendingRows.slice(0, 10) : [],
    extraAvailableSamples: Array.isArray(data?.extraAvailableRows) ? data.extraAvailableRows.slice(0, 10) : [],
  };
}

function humanBlockerText(blocker) {
  const code = String(blocker?.code || '');
  const msg = String(blocker?.message || '').trim();
  if (code === 'order_line_price_below_target') {
    const samples = Array.isArray(blocker?.evidence?.samples) ? blocker.evidence.samples : [];
    const shown = samples.slice(0, 3).map(row => `${row.storeKey || ''} ${row.canonical || row.goodsSn || row.skc || ''} 订单 ${row.orderNo || ''} 成交 ${num(row.currencyPrice)}，目标 ${num(row.finalTargetPrice)}，差 ${num(row.deltaSar)} SAR`).join('；');
    return shown
      ? `订单商品行成交价低于目标价：${shown}。必须查清活动/券/限时折扣来源并止损；本报告不会自动取消/补报。`
      : '有订单商品行成交价低于目标价，必须立刻查因和止损；本报告不会自动取消/补报。';
  }
  const map = {
    coupon_final_below_target: '有商品叠券后低于目标价，先止损，不能自动继续报名。',
    coupon_missing_price_evidence: '有商品缺少价格证据，系统先自动回读价格；取不到才报告具体阻塞。',
    low_price_cancel_rows_nonzero: '有低价/限时折扣叠券取消候选，先确认并取消错误优惠券。',
    old_ordinary_cancel_rows_nonzero: '有旧普通活动和优惠券叠加风险，先按目标价复核。',
    known_ordinary_coupon_final_below_target: '有旧普通活动价叠加 15% 券后会低于目标价；旧活动结束前禁止补券，如已上线才取消对应 15% 券。',
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
    new_listing_limited_discount_plan_not_generated: '新上架 7 天限时折扣已有待处理项，但缺少 rescue 文件；先生成计划并 dry-run。',
    order_line_price_below_target: '有订单商品行成交价低于目标价，必须立刻查因和止损；本报告不会自动取消/补报。',
    cloud_order_price_audit_unavailable: '云端订单商品行审计不可用，不能确认今天是否有低价成交。',
    cloud_order_fetch_files_missing: '云端订单商品行文件缺失，不能把缺数据当成无风险。',
    cloud_order_fetch_parse_error: '云端订单商品行文件解析失败，先修数据源。',
    cloud_order_fetch_source_mismatch: '云端订单商品行文件店铺或日期错位，不能把错位数据当成无风险。',
    cloud_order_fetch_stale: '云端订单商品行文件没有按时刷新，不能确认最新成交价风险。',
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
  const fallbackGaps = report.couponNonGuaranteedFallbackGaps || {};
  const mandatoryLimited = report.mandatoryLimitedDiscountStatus || {};
  const ordinaryIssues = report.ordinaryEnrollmentOpenIssues || {};
  const ordinarySupplementIssues = report.ordinaryEnrollmentSupplementOpenIssues || {};
  const highClickSpecial = report.highClickLowConversionSpecial || {};
  const highClickEffect = report.highClickSpecialEffect || {};

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
  const newListingLimited = newSkc.newListingWithin7DaysLimitedDiscount || {};
  if (Number(newListingLimited.actionCount || 0) > 0) {
    actions.push({
      level: '必须处理',
      text: `新上架 7 天/重新上架且无生效营销活动的 Top5 待遇链接有 ${humanCount(newListingLimited.actionCount, '个')}（新上架 ${humanCount(newListingLimited.newListingWithin7DaysCount || 0, '个')}，重新上架无活动 ${humanCount(newListingLimited.relistedWithoutActiveMarketingCount || 0, '个')}）：可生成/执行限时折扣计划 ${humanCount(newListingLimited.executableActionCount ?? newListingLimited.readyDryRunCount ?? 0, '个')}，缺目标价证据阻断 ${humanCount(newListingLimited.priceEvidenceBlockedCount || 0, '个')}，缺限时折扣 ${humanCount(newListingLimited.missingLimitedDiscountCount, '个')}，已有旧限时折扣但需按“一周窗口+曝光前五力度”复核/重报 ${humanCount(newListingLimited.existingLimitedDiscountRebuildCount, '个')}。这类按规则应自动生成限时折扣兜底并回读；BI 库存字段只能作为线索，不能替代营销后台 live/dry-run 库存校验。`,
    });
  } else if (newListingLimited.enabled !== false) {
    ok.push('新上架 7 天/重新上架无活动限时折扣：没有需要 Top5 待遇兜底/重报的链接。');
  }
  if (Number(highClickSpecial.actionCount || 0) > 0) {
    watches.push(`高点击低转化专属折扣：${humanCount(highClickSpecial.actionCount, '条')}符合“7日曝光>3000、7日点击率>4%、7日销量=0”，已进入先登记保护、再 dry-run/执行/live 回读的自动队列；价格按同货号全局曝光Top5利润率再降2个百分点，库存10、周期7天。`);
  } else if (highClickSpecial.enabled !== false) {
    ok.push(`高点击低转化专属折扣：本轮符合条件 ${humanCount(highClickSpecial.qualifyingCount || 0, '条')}，其中已有有效人工特殊价保护 ${humanCount(highClickSpecial.protectedCount || 0, '条')}，无新增自动写入。`);
  }
  if (Number(highClickEffect.total || 0) > 0) {
    watches.push(`特殊折扣效果：跟踪 ${humanCount(highClickEffect.total, '条')}，最新7日口径已出单 ${humanCount(highClickEffect.convertedCount || 0, '条')}、仍在观察且0单 ${humanCount(highClickEffect.observingNoSaleCount || 0, '条')}、到期仍0单 ${humanCount(highClickEffect.endedWithoutSaleCount || 0, '条')}、当前指标缺失 ${humanCount(highClickEffect.missingCurrentMetricsCount || 0, '条')}；这是滚动7日方向性对比，不把同期变化误写成折扣因果。`);
  }
  if (Number(fallbackGaps.total || 0) > 0) {
    const storeText = storeCountText(fallbackGaps.byStore || {}, 6);
    const latestRepair = mandatoryLimited.latestAutoRepair || {};
    const executedText = Number(latestRepair.executedCount || 0) > 0
      ? `；最近已自动补 ${humanCount(latestRepair.executedCount, '个')}`
      : '';
    watches.push(`限时折扣必报：仍有 ${humanCount(fallbackGaps.total, '个')}兜底缺口${storeText ? `（${storeText}）` : ''}${executedText}；剩余多为历史 live/dry-run 已确认的库存/平台规则/已有折扣冲突，不能硬写，但需要后续继续观察。`);
  }
  if (Number(ordinaryIssues.issueCount || 0) > 0 || Number(ordinaryIssues.missingFillEvidence || 0) > 0) {
    watches.push(`普通活动补报还有 ${humanCount(ordinaryIssues.issueCount, '行')}价格/填价证据待回读，其中缺本轮填价证据 ${humanCount(ordinaryIssues.missingFillEvidence, '行')}；已报集合存在不等于价格完全验收。`);
  }
  if (Number(ordinarySupplementIssues.pricePendingRows || 0) > 0 || Number(ordinarySupplementIssues.extraAvailableRows || 0) > 0) {
    watches.push(`XC/45219 补报还有 ${humanCount(ordinarySupplementIssues.pricePendingRows, '行')}活动价待回读、${humanCount(ordinarySupplementIssues.extraAvailableRows, '行')}计划外可报因缺成本/标准目录证据阻断；不能当作价格完全验收。`);
  }
  if (Array.isArray(report.t3MarketingCandidates) && report.t3MarketingCandidates.length) {
    const handledText = Number(report.t3MarketingHandledRows?.handledRows || 0) > 0
      ? `（已扣除本轮补报/阻断 ${humanCount(report.t3MarketingHandledRows.handledRows, '行')}）`
      : '';
    watches.push(`未来 3 天内有 ${humanCount(report.t3MarketingCandidates.length, '个')}普通营销活动报名提醒${handledText}；只提醒，不自动填报。`);
  } else {
    const handledText = Number(report.t3MarketingHandledRows?.handledRows || 0) > 0
      ? `；本轮补报/阻断 ${humanCount(report.t3MarketingHandledRows.handledRows, '行')}已扣除`
      : '';
    ok.push(`未来 3 天普通营销活动：暂无需要提醒的报名候选${handledText}。`);
  }
  const couponTrafficIntent = report.couponTrafficIntent || {};
  if (couponTrafficIntent.enabled) {
    if (Number(budget.belowTargetCount || 0) > 0) {
      actions.push({level: '必须处理', text: `有 ${humanCount(budget.belowTargetCount, '个')}店铺优惠券预算低于当前流量券预算目标，需要先确认预算方案。`});
    } else if (Number(budget.missingEvidenceCount || 0) > 0) {
      actions.push({level: '必须处理', text: `有 ${humanCount(budget.missingEvidenceCount, '个')}店铺缺可选流量券预算回读证据；要提交流量券前必须先回读确认。`});
    } else if (Number(budget.expectedStoreCount || 0) > 0) {
      ok.push('可选流量券预算：当前没有低于目标预算的店铺。');
    }
  } else if (Number(budget.belowTargetCount || 0) > 0 || Number(budget.missingEvidenceCount || 0) > 0) {
    watches.push('优惠券预算证据不完整/过期，但当前没有明确可选流量券目标；它不再阻塞价格止损，只在后续真正要上流量券前回读。');
  }
  if (Number(orders.above || 0) > 0) {
    watches.push(`订单商品行成交价有 ${humanCount(orders.above, '条')}高于目标价线索；先查普通活动/限时折扣/券是否漏报，不自动取消任何活动。`);
  }
  if (Number(orders.dataQualityRows || 0) > 0) {
    watches.push(`订单商品行审计有 ${humanCount(orders.dataQualityRows, '条')}缺计划、缺价格或数量粒度不明的数据质量问题；不能当作无风险。`);
  }
  if (Number(orders.cloud?.matchedPlanRows || 0) > 0 && Number(orders.below || 0) === 0 && Number(orders.above || 0) === 0 && Number(orders.dataQualityRows || 0) === 0) {
    ok.push(`云端订单商品行成交价：近 ${humanCount(orders.cloud.lookbackDays + 1, '天')}读取 ${humanCount(orders.cloud.rows, '行')}，其中 ${humanCount(orders.cloud.matchedPlanRows, '行')}命中目标价计划并完成比价，未发现低于/高于目标价。`);
  }
  const optionalTrafficCouponReview = report.optionalTrafficCouponReview || {};
  if (!optionalTrafficCouponReview.open) {
    watches.push('当前计划没有明确可选 15% 流量券目标；价格保障不能依赖优惠券，今天不生成补券 dry-run。');
  } else if (Array.isArray(report.suggestedDryRunCommands) && report.suggestedDryRunCommands.length) {
    watches.push('当前计划存在明确可选 15% 流量券目标；只生成 34810/15% 券 dry-run 供用户确认，不能把优惠券当价格保障层。');
  } else if (optionalTrafficCouponReview.open) {
    ok.push('优惠券价格保障迁移：当前没有需要补回的价格保障券；优惠券不再作为目标成交价保底层。');
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
  lines.push('## 限时折扣兜底情况');
  lines.push('');
  const mandatoryLimited = report.mandatoryLimitedDiscountStatus || {};
  const mandatoryHuman = mandatoryLimited.human || {};
  lines.push(`- 巡检：${mandatoryHuman.liveEvidenceText || '未生成限时折扣巡检摘要。'}`);
  lines.push(`- 自动补报：${mandatoryHuman.autoRepairText || '未生成限时折扣补报摘要。'}`);
  lines.push(`- 剩余缺口：${mandatoryHuman.remainingText || '未生成限时折扣缺口摘要。'}`);
  lines.push(`- 后续动作：${mandatoryHuman.actionText || '继续按必报兜底规则巡检。'}`);
  lines.push('');
  lines.push('## 高点击低转化专属折扣');
  lines.push('');
  const highClickSpecial = report.highClickLowConversionSpecial || {};
  const highClickEffect = report.highClickSpecialEffect || {};
  lines.push('- 触发条件：当前在售，近7天曝光人数严格大于3000、近7天点击率严格大于4%，且近7天销量明确为0；缺失销量不按0处理。');
  lines.push(`- 本轮候选：符合 ${humanCount(highClickSpecial.qualifyingCount || 0, '条')}；新增待自动登记/执行 ${humanCount(highClickSpecial.actionCount || 0, '条')}；已有人工特殊价保护 ${humanCount(highClickSpecial.protectedCount || 0, '条')}；价格证据阻断 ${humanCount(highClickSpecial.blockedCount || 0, '条')}。`);
  lines.push('- 执行口径：同货号全局曝光Top5利润率再降低2个百分点，库存10、周期7天；先登记人工特殊价保护，再 dry-run、执行和 live 回读。');
  if ((highClickSpecial.rows || []).length) {
    lines.push('');
    lines.push('| 店铺 | 品名/货号 | SKC | 7日曝光 | 7日点击率 | 7日销量 | 专属价 SAR |');
    lines.push('|---|---|---|---:|---:|---:|---:|');
    for (const row of highClickSpecial.rows.slice(0, 20)) {
      lines.push(`| ${row.storeKey} | ${String(row.productName || row.canonical || '').replaceAll('|', '/')} | ${row.skc} | ${row.metrics?.c7Exposure ?? ''} | ${humanPercent(row.metrics?.c7ClickRate)} | ${row.metrics?.c7SaleCount ?? ''} | ${num(row.specialPrice)} |`);
    }
  }
  lines.push('');
  lines.push(`- 效果跟踪：共 ${humanCount(highClickEffect.total || 0, '条')}；最新7日已出单 ${humanCount(highClickEffect.convertedCount || 0, '条')}；活动中仍0单 ${humanCount(highClickEffect.observingNoSaleCount || 0, '条')}；到期仍0单 ${humanCount(highClickEffect.endedWithoutSaleCount || 0, '条')}；缺当前指标 ${humanCount(highClickEffect.missingCurrentMetricsCount || 0, '条')}；缺基线 ${humanCount(highClickEffect.missingBaselineCount || 0, '条')}。`);
  lines.push('- 效果解释：按报名时基线与当前滚动7日曝光、点击率、销量做方向性对比；报告不会把同期流量变化直接当成折扣造成。');
  if ((highClickEffect.rows || []).length) {
    lines.push('');
    lines.push('| 店铺 | 品名/货号 | SKC | 特殊价 | 状态 | 基线曝光/点击率/销量 | 当前曝光/点击率/销量 | 判断 |');
    lines.push('|---|---|---|---:|---|---|---|---|');
    for (const row of highClickEffect.rows.slice(0, 30)) {
      const baseline = row.baseline || {};
      const current = row.current || {};
      lines.push(`| ${row.storeKey} | ${String(row.canonical || '').replaceAll('|', '/')} | ${row.skc} | ${num(row.specialPrice)} | ${humanWindowStatus(row.windowStatus)} | ${baseline.c7Exposure ?? '缺'}/${humanPercent(baseline.c7ClickRate)}/${baseline.c7SaleCount ?? '缺'} | ${current.c7Exposure ?? '缺'}/${humanPercent(current.c7ClickRate)}/${current.c7SaleCount ?? '缺'} | ${humanEffectStatus(row.effectStatus)} |`);
    }
  }
  lines.push('');
  lines.push('## 今日关键状态');
  lines.push('');
  lines.push(`- 价格止损阻塞：${report.blockers.length ? `${humanCount(report.blockers.length, '个')}，不能自动执行` : '无'}`);
  lines.push(`- 旧普通活动叠券：未处理低价 ${humanCount(report.knownOrdinaryActivityGuard.belowTargetCount, '个')}；待系统只读查价 ${humanCount(report.knownOrdinaryActivityGuard.evidenceIncompleteCount, '个')}；已取消止损 ${humanCount(report.knownOrdinaryActivityGuard.mitigatedBelowTargetCount || 0, '个')}`);
  lines.push(`- 限时折扣叠券：低价 ${humanCount(report.lowPriceOverlap.belowTarget, '个')}；待系统补价证据 ${humanCount(report.lowPriceOverlap.missingEvidence, '个')}；取消候选 ${humanCount(report.lowPriceOverlap.cancelRows, '个')}`);
  lines.push(`- 订单商品行成交价：云端读取 ${humanCount(report.orderPriceAudit.cloud?.rows || 0, '行')}；活动窗口内命中目标并比价 ${humanCount(report.orderPriceAudit.cloud?.matchedPlanRows || 0, '行')}；窗口外历史线索 ${humanCount(report.orderPriceAudit.outsideWindow, '条')}；未命中计划背景数 ${humanCount(report.orderPriceAudit.cloud?.unmatchedRows || 0, '行')}；低于目标 ${humanCount(report.orderPriceAudit.below, '条')}；高于目标 ${humanCount(report.orderPriceAudit.above, '条')}；缺窗口/价格/粒度证据 ${humanCount(report.orderPriceAudit.dataQualityRows, '条')}`);
  const manualSpecial = report.manualSpecialLimitedDiscount || report.limitedDiscountTargetPriceDrift?.manualSpecialLimitedDiscount || {};
  lines.push(`- 人工特殊限时折扣保护：有效登记 ${humanCount(manualSpecial.activeCount || 0, '条')}；精确覆盖 ${humanCount((manualSpecial.coveredRows || []).length, '条')}；缺失/错价待恢复 ${humanCount(manualSpecial.actionCount || 0, '条')}。`);
  lines.push(`- 高点击低转化专属折扣：符合 ${humanCount(highClickSpecial.qualifyingCount || 0, '条')}；新增自动队列 ${humanCount(highClickSpecial.actionCount || 0, '条')}；已保护 ${humanCount(highClickSpecial.protectedCount || 0, '条')}；效果已出单 ${humanCount(highClickEffect.convertedCount || 0, '条')}。`);
  const couponTrafficIntent = report.couponTrafficIntent || {};
  const budgetPrefix = couponTrafficIntent.enabled ? '可选流量券预算' : '优惠券预算观察';
  lines.push(`- ${budgetPrefix}：明确流量券目标 ${humanCount(couponTrafficIntent.allowed15TrafficCount || 0, '个')}；低于预算目标的店铺 ${humanCount(report.couponBudget.belowTargetCount, '个')}；缺回读证据 ${humanCount(report.couponBudget.missingEvidenceCount, '个')}`);
  lines.push(`- 限时折扣必报兜底：live 当前限时折扣 ${humanCount(report.mandatoryLimitedDiscountStatus?.live?.limitedRows || 0, '行')}；最近自动补报 ${humanCount(report.mandatoryLimitedDiscountStatus?.latestAutoRepair?.executedCount || 0, '个')}；剩余阻断 ${humanCount(report.mandatoryLimitedDiscountStatus?.latestAutoRepair?.blockedCount || report.couponNonGuaranteedFallbackGaps?.total || 0, '个')}；直接命中低价订单 ${humanCount(report.couponNonGuaranteedFallbackGaps?.lowOrderHitCount || 0, '个')}`);
  const newListingLimited = report.newSkcCandidates?.newListingWithin7DaysLimitedDiscount || {};
  lines.push(`- 新上架7天/重新上架无活动限时折扣：待处理 ${humanCount(newListingLimited.actionCount || 0, '个')}（新上架 ${humanCount(newListingLimited.newListingWithin7DaysCount || 0, '个')}，重新上架 ${humanCount(newListingLimited.relistedWithoutActiveMarketingCount || 0, '个')}）；可生成/执行计划 ${humanCount(newListingLimited.executableActionCount ?? newListingLimited.readyDryRunCount ?? 0, '个')}；live 已证明覆盖无需重复写入 ${humanCount(newListingLimited.liveCoveredNoActionCount || 0, '个')}；缺目标价证据阻断 ${humanCount(newListingLimited.priceEvidenceBlockedCount || 0, '个')}；缺限时折扣 ${humanCount(newListingLimited.missingLimitedDiscountCount || 0, '个')}；已有旧限时折扣需按前五力度/一周窗口复核重报 ${humanCount(newListingLimited.existingLimitedDiscountRebuildCount || 0, '个')}`);
  lines.push(`- 普通活动补报回读：计划 ${humanCount(report.ordinaryEnrollmentOpenIssues?.plannedRows || 0, '行')}；已报/审核中 ${humanCount(report.ordinaryEnrollmentOpenIssues?.enrolledOrUnderReview || 0, '行')}；价格/证据待回读 ${humanCount(report.ordinaryEnrollmentOpenIssues?.issueCount || 0, '行')}；缺本轮填价证据 ${humanCount(report.ordinaryEnrollmentOpenIssues?.missingFillEvidence || 0, '行')}`);
  lines.push(`- XC/45219 补报遗留：活动价待回读 ${humanCount(report.ordinaryEnrollmentSupplementOpenIssues?.pricePendingRows || 0, '行')}；缺成本/标准目录阻断 ${humanCount(report.ordinaryEnrollmentSupplementOpenIssues?.extraAvailableRows || 0, '行')}`);
  lines.push(`- 新链接/新 SKC：需要定价 ${humanCount(report.newSkcCandidates.needsPricing, '个')}；需要确认 ${humanCount(report.newSkcCandidates.needsConfirmation, '个')}；需要补券复核 ${humanCount(report.newSkcCandidates.needsCouponReview, '个')}`);
  lines.push(`- 未来 3 天普通活动提醒：${humanCount(report.t3MarketingCandidates.length, '个')}；已扣除补报/阻断 ${humanCount(report.t3MarketingHandledRows?.handledRows || 0, '行')}`);
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
  const now = args.now ? parseAnyDateTime(args.now) : new Date();
  const sources = [];
  const read = async (label, file) => {
    const item = await readSource(label, file, now, args.maxAgeHours);
    sources.push(item.source);
    return item;
  };

  const biPortalSelection = await selectSharedBiPortalSource({
    root: ROOT,
    biPortalData: args.biPortalData,
    cloudBiSsh: isLocalCloudHost(args.cloudBiSsh) ? '' : args.cloudBiSsh,
    cloudBiRoot: args.cloudBiRoot,
    cloudBiSshTimeoutMs: args.cloudBiSshTimeoutMs,
    cloudBiMaxBytes: args.cloudBiMaxBytes,
    now,
    maxAgeHours: args.maxAgeHours,
  });
  const biPortal = biPortalSelection.selected;
  sources.push(biPortal.source);
  const biPortalLinksData = await read('biPortalLinksData', args.biPortalLinksData);
  const marketingPricingPolicy = await loadMarketingPricingPolicy(MARKETING_PRICING_POLICY_DEFAULT);
  const manualLimitedDiscountRegistry = await loadManualLimitedDiscountRegistry();
  const ordinaryPlatformTierRegistry = await loadOrdinaryPlatformTierRegistry({root: ROOT});
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
  const budgetReadback = await read('couponBudgetReadback', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results'), /^coupon-site-budget-readback-.*\.json$/));
  const budgetDryRun = await read('couponBudgetDryRun', latestFile(path.join(ROOT, 'tmp', 'marketing-signup', 'coupon-budget-results'), /^coupon-site-budget-dry-run-.*\.json$/));
  const couponNonGuaranteedFallbackGapSource = await read(
    'couponNonGuaranteedFallbackGaps',
    latestReportFile(/^coupon-non-guaranteed-limited-fallback-remaining-triage-.*\.json$/),
  );
  const currentMarketingLiveScanSource = await readSource(
    'currentMarketingLiveScan',
    latestCurrentMarketingLiveScanFile(
      path.join(ROOT, 'tmp', 'marketing-signup', 'current-price-live'),
      /^current-marketing-price-live-.*\.json$/,
      storesConfig.data,
    ),
    now,
    args.maxAgeHours,
  );
  const mandatoryLimitedGapFinalSource = await readSource(
    'mandatoryLimitedGapFinalResult',
    latestReportFile(/^(?:mandatory-limited-gap-final-result-.*|new-listing-7d-limited-discount-execution-summary-\d{4}-\d{2}-\d{2}(?:-.*)?)\.json$/),
    now,
    args.maxAgeHours,
  );
  const ordinaryEnrollmentOpenIssueSource = await read(
    'ordinaryEnrollmentOpenIssues',
    latestReportFile(/^remaining-open-extra-cloud-enriched-submit-result-.*\.json$/),
  );
  const ordinaryEnrollmentSupplementOpenIssueSource = await read(
    'ordinaryEnrollmentSupplementOpenIssues',
    latestReportFile(/^xc-45219-open-issues-.*\.json$/),
  );
  const deadlineGapfillResultSource = await read(
    'ordinaryDeadlineGapfillResult',
    latestReportFile(/^remaining-\d{4}-\d{2}-\d{2}-deadline-gapfill-result-.*\.json$/),
  );
  const stackReviewSelection = selectMarketingStackReviewFile(storesConfig.data);
  const stackReview = await read('marketingStackReview', stackReviewSelection.file);
  const marketingStackReviewContext = normalizeMarketingStackReviewSource(stackReview, now, args.maxAgeHours);
  const knownOrdinaryEvidenceDir = DEADLINE_FILL_RESULTS_DIR;
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
  if (knownOrdinaryEvidenceSource.exists) {
    const evidenceStoreKeys = [...new Set([
      ...enabledStoreKeysFromConfig(storesConfig.data),
      ...mapKeys(couponEligibilityPlan?.rowsByStore),
      ...mapKeys(couponEligibilityPlan?.allowed15ByStore || couponEligibilityPlan?.byStore),
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
  const ordinaryPlatformTierIndex = buildOrdinaryPlatformTierEvidenceIndex({
    registry: ordinaryPlatformTierRegistry,
    ordinaryEvidenceByStore,
  });
  const knownOrdinaryCancelMitigation = await loadKnownOrdinaryCancelMitigation(args.date);
  const orderPriceMitigationEvidence = loadOrderPriceMitigationEvidence(args.date);
  const activityWindowEvidence = loadActivityWindowEvidence(targetPlan.data, priceOverrides.data, biPortalLinksData.data);

  const cloudOrderRows = await readCloudSheinFetchOrderRows({
    cloudBiSsh: args.cloudBiSsh,
    cloudBiRoot: args.cloudBiRoot,
    cloudBiSshTimeoutMs: args.cloudBiSshTimeoutMs,
    cloudBiMaxBytes: args.cloudBiMaxBytes,
    stores: enabledStoreKeysFromConfig(storesConfig.data),
    dates: reportDateLookbackDates(args.date, CLOUD_ORDER_LOOKBACK_DAYS),
  });

  const couponSubmitDryRun = summarizeCouponSubmit(couponSubmit.data);
  couponSubmitDryRun.summaryPath = rel(couponSubmitPath);

  const marketingStackReviewCoverage = summarizeStackReviewCoverage(stackReview.data, storesConfig.data);
  const legacyLowPriceOverlap = summarizeLowPriceOverlap(lowLive.data, lowCancel.data);
  const freshLiveLowPriceOverlap = summarizeFreshLiveLowPriceOverlap({
    stackDoc: stackReview.data,
    stackSource: stackReview.source,
    stackCoverage: marketingStackReviewCoverage,
    liveScanSource: currentMarketingLiveScanSource,
    couponPlan: couponEligibilityPlan,
    storesConfigDoc: storesConfig.data,
    now,
  });
  const lowPriceOverlap = freshLiveLowPriceOverlap.trusted
    ? freshLiveLowPriceOverlap
    : {
      ...legacyLowPriceOverlap,
      source: 'legacy_coupon_overlap_artifacts',
      trusted: false,
      freshEvidence: freshLiveLowPriceOverlap,
    };
  const legacyOldOrdinaryOverlap = summarizeOldOrdinaryOverlap(oldLive.data, oldCancel.data);
  const oldOrdinaryOverlap = freshLiveLowPriceOverlap.trusted
    ? {
      source: freshLiveLowPriceOverlap.source,
      supersededLegacyArtifacts: true,
      riskCancel: false,
      cancelRows: 0,
      observationRows: freshLiveLowPriceOverlap.activeOrdinaryOverlapCount,
      riskRows: freshLiveLowPriceOverlap.rows.filter(row => row.promotionType === 'ordinary_marketing'
        && (row.shouldCancelCoupon || String(row.priceDecision || '').startsWith('missing_'))).length,
      storeCount: freshLiveLowPriceOverlap.storeCount,
      allStoresOk: true,
    }
    : legacyOldOrdinaryOverlap;
  const knownOrdinaryActivityGuard = summarizeKnownOrdinaryActivityGuard({
    couponPlan: couponEligibilityPlan,
    ordinaryEvidenceByStore,
    stackDoc: stackReview.data,
    cancelMitigation: knownOrdinaryCancelMitigation,
  });
  const aboveTargetActions = summarizeAboveTargetActions(abovePlan.data);
  const cloudOrderPriceAudit = summarizeCloudOrderPriceAudit({
    cloudRowsDoc: cloudOrderRows,
    priceOverridesDoc: priceOverrides.data,
    priceOverridesSourcePath: priceOverrides.source.path,
    activityWindowEvidence,
    orderMitigationEvidence: orderPriceMitigationEvidence,
    manualLimitedDiscountRegistry,
    ordinaryPlatformTierIndex,
    now,
    maxAgeHours: args.maxAgeHours,
    linksDataDoc: biPortalLinksData.source.status === 'ok' ? biPortalLinksData.data : null,
    linksDataSourcePath: biPortalLinksData.source.status === 'ok' ? biPortalLinksData.source.path : '',
  });
  const limitedDiscountTargetPriceDrift = summarizeLimitedDiscountTargetPriceDrift({
    liveScanSource: currentMarketingLiveScanSource,
    priceOverridesDoc: priceOverrides.data,
    priceOverridesSourcePath: priceOverrides.source.path,
    activityWindowEvidence,
    now,
    manualLimitedDiscountRegistry,
    linksDataDoc: biPortalLinksData.source.status === 'ok' ? biPortalLinksData.data : null,
    linksDataSourcePath: biPortalLinksData.source.status === 'ok' ? biPortalLinksData.source.path : '',
  });
  const orderPriceAudit = buildOrderPriceAuditFromCloud(cloudOrderPriceAudit);
  const biPortalFreshness = summarizeBiPortal(biPortal.data, biPortal.source);
  const deadlineHandledKeys = collectDeadlineHandledKeys(deadlineGapfillResultSource.data);
  const t3MarketingCandidates = summarizeT3Candidates(stackReview.data, args.date, deadlineHandledKeys);
  const t3MarketingHandledRows = {
    sourcePath: deadlineGapfillResultSource.source.path || '',
    handledRows: Number(t3MarketingCandidates.handledRows || 0),
    handledKeyCount: deadlineHandledKeys.size,
  };
  const couponBudget = summarizeCouponBudgetStatus({
    executeDoc: budgetExecute.data,
    executeSource: budgetExecute.source,
    readbackDoc: budgetReadback.data,
    readbackSource: budgetReadback.source,
    dryRunDoc: budgetDryRun.data,
    dryRunSource: budgetDryRun.source,
    storesConfigDoc: storesConfig.data,
    targetBudget: 1000,
  });
  const newSkcCandidates = summarizeNewSkcCandidates({
    biDoc: biPortal.data,
    biSource: biPortal.source,
    linksDataDoc: biPortalLinksData.data,
    linksDataSource: biPortalLinksData.source,
    selectionPlanDoc: targetPlan.data,
    priceOverridesDoc: priceOverrides.data,
    priceOverridesSourcePath: priceOverrides.source.path,
    storesConfigDoc: storesConfig.data,
    pricingPolicy: marketingPricingPolicy,
    reportDate: args.date,
    currentMarketingLiveScanSource,
    manualLimitedDiscountRegistry,
    now,
  });
  const highClickSpecialPolicy = getHighClickSpecialPolicy(marketingPricingPolicy);
  const highClickLowConversionSpecial = buildHighClickLowConversionSpecialAudit({
    linksDataDoc: biPortalLinksData.data,
    priceOverridesDoc: priceOverrides.data,
    costDoc: readJsonSafe(MARKETING_COST_MAP_DEFAULT) || {},
    manualRegistry: manualLimitedDiscountRegistry,
    marketingPolicy: marketingPricingPolicy,
    reportDate: args.date,
    now,
    sourceLinksData: biPortalLinksData.source.path || rel(args.biPortalLinksData),
    sourceLinksDataStatus: biPortalLinksData.source.status || 'missing',
    sourcePriceOverrides: priceOverrides.source.path || rel(args.priceOverrides),
    sourceCostMap: rel(MARKETING_COST_MAP_DEFAULT),
  });
  const highClickSpecialEffect = buildHighClickSpecialEffectAudit({
    linksDataDoc: biPortalLinksData.data,
    manualRegistry: manualLimitedDiscountRegistry,
    experimentLedger: readJsonSafe(HIGH_CLICK_EFFECT_LEDGER_DEFAULT),
    root: ROOT,
    now,
    policy: highClickSpecialPolicy,
  });
  const couponTrafficIntent = summarizeCouponTrafficIntent(couponEligibilityPlan);
  const optionalTrafficCouponReview = optionalTrafficCouponReviewStatus({couponEligibilityPlan});
  const couponNonGuaranteedFallbackGaps = summarizeCouponNonGuaranteedFallbackGaps(couponNonGuaranteedFallbackGapSource);
  const mandatoryLimitedDiscountStatus = summarizeMandatoryLimitedDiscountStatus({
    liveScanSource: currentMarketingLiveScanSource,
    gapResultSource: mandatoryLimitedGapFinalSource,
    fallbackGaps: couponNonGuaranteedFallbackGaps,
  });
  const ordinaryEnrollmentOpenIssues = summarizeOrdinaryEnrollmentOpenIssues(ordinaryEnrollmentOpenIssueSource);
  const ordinaryEnrollmentSupplementOpenIssues = summarizeOrdinaryEnrollmentSupplementOpenIssues(ordinaryEnrollmentSupplementOpenIssueSource);
  const suggestedDryRunCommands = buildDryRunCommands({
    targetPlan: args.targetPlan,
    priceOverrides: args.priceOverrides,
    optionalTrafficCouponReview,
    couponEligibilityPlan,
    newSkcCandidates,
    limitedDiscountTargetPriceDrift,
    reportDate: args.date,
  });
  const blockers = [];
  const sourceWarnings = [];
  const contextWarnings = [];
  const unknownSources = [];
  const freshCouponEvidenceSupersedesLegacy = freshLiveLowPriceOverlap.trusted === true;
  if (freshCouponEvidenceSupersedesLegacy) {
    contextWarnings.push({
      code: 'legacy_coupon_evidence_superseded',
      label: 'liveCouponLimitedOverlap',
      message: '本轮已直接读取 19 店实时 15% 券 active 集合并与当次限时折扣 live scan 交叉校验；旧 coupon submit/low-price 中间文件仅留历史审计，不再作为当前阻断。',
      evidence: {
        source: freshLiveLowPriceOverlap.source,
        storeCount: freshLiveLowPriceOverlap.storeCount,
        activeCouponCount: freshLiveLowPriceOverlap.activeCouponCount,
        activePromotionOverlapCount: freshLiveLowPriceOverlap.activePromotionOverlapCount,
        activeOrdinaryOverlapCount: freshLiveLowPriceOverlap.activeOrdinaryOverlapCount,
        activeLimitedOverlapCount: freshLiveLowPriceOverlap.activeLimitedOverlapCount,
      },
    });
    if (freshLiveLowPriceOverlap.activeCouponOutsideAllowedPlan > 0
      && freshLiveLowPriceOverlap.activeCouponOutsideAllowedPlanOverlap === 0) {
      contextWarnings.push({
        code: 'standalone_active_coupon_outside_current_plan',
        label: 'liveCouponPriceStack',
        message: `实时发现 ${freshLiveLowPriceOverlap.activeCouponOutsideAllowedPlan} 个历史 active 券商品不在当前可选流量券计划，但本轮未与任何当前/未来普通活动或限时折扣重叠；仅留观察，不误判为价格栈风险。`,
        evidence: {samples: freshLiveLowPriceOverlap.activeCouponOutsideAllowedPlanRows.slice(0, 20)},
      });
    }
  }
  const completedHistoricalSourceLabels = new Set();
  if (ordinaryEnrollmentOpenIssues.issueCount === 0 && ordinaryEnrollmentOpenIssues.missingFillEvidence === 0) {
    completedHistoricalSourceLabels.add('ordinaryEnrollmentOpenIssues');
  }
  if (ordinaryEnrollmentSupplementOpenIssues.pricePendingRows === 0
    && ordinaryEnrollmentSupplementOpenIssues.extraAvailableRows === 0) {
    completedHistoricalSourceLabels.add('ordinaryEnrollmentSupplementOpenIssues');
  }

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
  if ((stackReviewSelection.skippedNewerIncomplete || []).length) {
    contextWarnings.push({
      code: 'marketing_stack_skipped_newer_incomplete_review',
      label: 'marketingStackReview',
      message: '存在更新的单店/不完整营销栈调查文件；全局日报已跳过，改用覆盖全部启用店铺的报告',
      evidence: {
        selectedPath: stackReviewSelection.selectedPath,
        selectionReason: stackReviewSelection.selectionReason,
        skipped: stackReviewSelection.skippedNewerIncomplete,
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
    if (freshCouponEvidenceSupersedesLegacy && LEGACY_COUPON_EVIDENCE_SOURCE_LABELS.has(src.label)) {
      continue;
    }
    if (src.status === 'stale' && (NON_EXPIRING_VERSIONED_SOURCE_LABELS.has(src.label)
      || completedHistoricalSourceLabels.has(src.label))) {
      continue;
    }
    const optionalBudgetSourceCovered = (
      (couponBudget.selectedSource === 'execute' && ['couponBudgetDryRun', 'couponBudgetReadback'].includes(src.label))
      || (couponBudget.selectedSource === 'readback_current' && ['couponBudgetExecute', 'couponBudgetDryRun'].includes(src.label))
    );
    if (optionalBudgetSourceCovered && ['missing', 'parse_error', 'stale'].includes(src.status)) {
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
      const thresholdHours = Number.isFinite(Number(src.activityFreshnessThresholdHours))
        ? Number(src.activityFreshnessThresholdHours)
        : args.maxAgeHours;
      const message = src.label === 'marketingStackReview'
        ? `${src.label} 活动扫描已超过 ${thresholdHours} 小时，系统必须先刷新只读营销叠加审核/取证，不能自动执行或给 no-action`
        : `${src.label} 已超过 ${thresholdHours} 小时`;
      addBlocker(blockers, 'source_stale', message, {
        path: src.path,
        artifactAgeHours: src.artifactAgeHours,
        dataAgeHours: src.dataAgeHours,
        activityAgeHours: src.activityAgeHours,
        thresholdHours,
      });
    } else if (src.status === 'stale') {
      sourceWarnings.push({
        code: 'source_stale',
        label: src.label,
        message: `${src.label} 已超过 ${args.maxAgeHours} 小时，不能作为 no-action 的完整新鲜证据`,
        evidence: {path: src.path, artifactAgeHours: src.artifactAgeHours, dataAgeHours: src.dataAgeHours},
      });
    }
  }
  if (couponSubmitDryRun.status === 'untrusted' && !freshCouponEvidenceSupersedesLegacy) addBlocker(blockers, 'coupon_submit_not_dry_run', '最新优惠券提交 summary 不是 dry-run，不能作为自动任务安全证据', {path: couponSubmitDryRun.summaryPath});
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
  if (orderPriceAudit.cloud.status !== 'ok') {
    addBlocker(
      blockers,
      'cloud_order_price_audit_unavailable',
      `云端订单商品行审计不可用：${orderPriceAudit.cloud.status}`,
      {status: orderPriceAudit.cloud.status, error: orderPriceAudit.cloud.error || '', host: orderPriceAudit.cloud.host || '', root: orderPriceAudit.cloud.root || ''},
    );
  }
  if (orderPriceAudit.cloud.missingFileCount > 0) {
    addBlocker(
      blockers,
      'cloud_order_fetch_files_missing',
      `云端订单商品行文件缺失=${orderPriceAudit.cloud.missingFileCount}`,
      {samples: orderPriceAudit.cloud.missingFiles.slice(0, 20)},
    );
  }
  if (orderPriceAudit.cloud.parseErrorFileCount > 0) {
    addBlocker(
      blockers,
      'cloud_order_fetch_parse_error',
      `云端订单商品行文件解析失败=${orderPriceAudit.cloud.parseErrorFileCount}`,
      {samples: orderPriceAudit.cloud.parseErrorFiles.slice(0, 20)},
    );
  }
  if (orderPriceAudit.cloud.sourceMismatchFileCount > 0) {
    addBlocker(
      blockers,
      'cloud_order_fetch_source_mismatch',
      `云端订单商品行文件店铺/日期错位=${orderPriceAudit.cloud.sourceMismatchFileCount}`,
      {samples: orderPriceAudit.cloud.sourceMismatchFiles.slice(0, 20)},
    );
  }
  if (orderPriceAudit.cloud.staleFileCount > 0) {
    addBlocker(
      blockers,
      'cloud_order_fetch_stale',
      `云端订单商品行文件 fetchTime 过期或缺失=${orderPriceAudit.cloud.staleFileCount}`,
      {samples: orderPriceAudit.cloud.staleFiles.slice(0, 20), maxAgeHours: args.maxAgeHours},
    );
  }
  if (orderPriceAudit.cloud.below > 0) {
    addBlocker(
      blockers,
      'order_line_price_below_target',
      `订单商品行成交价低于目标=${orderPriceAudit.cloud.below}`,
      {samples: orderPriceAudit.cloud.belowRows.slice(0, 20)},
    );
  }
  const newListingLimitedForBlocker = newSkcCandidates.newListingWithin7DaysLimitedDiscount || {};
  const latestRawLinkOverlayForBlocker = newSkcCandidates.latestRawLinkOverlay || {};
  if (latestRawLinkOverlayForBlocker.complete !== true) {
    addBlocker(
      blockers,
      'latest_raw_link_overlay_incomplete',
      `新链接原始快照覆盖不完整：应有 ${latestRawLinkOverlayForBlocker.expectedStoreCount || 0} 店，实际 ${latestRawLinkOverlayForBlocker.sourceFileCount || 0} 店，解析失败 ${latestRawLinkOverlayForBlocker.parseErrorCount || 0}；禁止据此输出无缺口`,
      {
        missingStoreKeys: latestRawLinkOverlayForBlocker.missingStoreKeys || [],
        errors: (latestRawLinkOverlayForBlocker.errors || []).slice(0, 20),
      },
    );
  }
  if (Number(newListingLimitedForBlocker.actionCount || 0) > 0 && Number(newListingLimitedForBlocker.readyDryRunCount || 0) <= 0) {
    addBlocker(
      blockers,
      'new_listing_limited_discount_plan_not_generated',
      `新上架7天/重新上架无活动限时折扣待处理 ${newListingLimitedForBlocker.actionCount} 个，但当前没有可执行 rescue 文件；应先生成 plan 再 dry-run`,
      {
        executableActionCount: newListingLimitedForBlocker.executableActionCount || 0,
        priceEvidenceBlockedCount: newListingLimitedForBlocker.priceEvidenceBlockedCount || 0,
        samples: (newListingLimitedForBlocker.rows || []).slice(0, 20),
      },
    );
  }
  if (limitedDiscountTargetPriceDrift.belowTarget > 0) {
    addBlocker(
      blockers,
      'limited_discount_price_below_current_target',
      `live 限时折扣价低于当前窗口目标价=${limitedDiscountTargetPriceDrift.belowTarget}`,
      {
        samples: limitedDiscountTargetPriceDrift.belowRows.slice(0, 20),
        planSourcePath: limitedDiscountTargetPriceDrift.planSourcePath,
      },
    );
  }
  const manualSpecialLimitedDiscount = limitedDiscountTargetPriceDrift.manualSpecialLimitedDiscount || {};
  if (Number(manualSpecialLimitedDiscount.actionCount || 0) > 0) {
    addBlocker(
      blockers,
      'manual_special_limited_discount_restore_required',
      `用户批准的人工特殊限时折扣缺失/错价/库存或时间窗不符=${manualSpecialLimitedDiscount.actionCount}`,
      {
        registrySource: manualSpecialLimitedDiscount.registrySource || '',
        missingRows: (manualSpecialLimitedDiscount.missingRows || []).slice(0, 20),
        priceMismatchRows: (manualSpecialLimitedDiscount.priceMismatchRows || []).slice(0, 20),
        coverageMismatchRows: (manualSpecialLimitedDiscount.coverageMismatchRows || []).slice(0, 20),
      },
    );
  }
  if (Number(highClickLowConversionSpecial.blockedCount || 0) > 0) {
    sourceWarnings.push({
      code: 'high_click_special_pricing_blocked',
      label: 'highClickLowConversionSpecial',
      message: `高点击低转化专属折扣有 ${highClickLowConversionSpecial.blockedCount} 条因成本/Top5价格/利润率底线证据不足而未进入自动写入队列`,
      evidence: {samples: (highClickLowConversionSpecial.blockedRows || []).slice(0, 20)},
    });
  }
  if (orderPriceAudit.cloud.dataQualityRows > 0) {
    sourceWarnings.push({
      code: 'cloud_order_price_data_quality',
      label: 'orderPriceAudit',
      message: `云端订单商品行审计有 ${orderPriceAudit.cloud.dataQualityRows} 行缺活动窗口、缺订单时间、缺价格或数量粒度不明；不能当作无风险`,
      evidence: {samples: orderPriceAudit.cloud.dataQualitySamples.slice(0, 20)},
    });
  }
  if (orderPriceAudit.cloud.duplicatePlanConflictCount > 0) {
    sourceWarnings.push({
      code: 'order_target_plan_duplicate_conflicts',
      label: 'orderPriceAudit',
      message: `目标价计划存在 ${orderPriceAudit.cloud.duplicatePlanConflictCount} 个同活动内重复 storeKey+skc 且目标价不同；订单审计已保守使用最高 finalTargetPrice，仍需清理计划`,
      evidence: {conflicts: orderPriceAudit.cloud.duplicatePlanConflicts.slice(0, 20), planSourcePath: orderPriceAudit.cloud.planSourcePath},
    });
  } else if (orderPriceAudit.cloud.duplicatePlanKeys.length > 0) {
    contextWarnings.push({
      code: 'order_target_plan_duplicate_keys_same_target',
      label: 'orderPriceAudit',
      message: `目标价计划存在 ${orderPriceAudit.cloud.duplicatePlanKeys.length} 个跨活动重复 storeKey+skc（不同 activityId），这是正常的同款多活动报名，不需要清理`,
      evidence: {duplicateKeys: orderPriceAudit.cloud.duplicatePlanKeys.slice(0, 20), planSourcePath: orderPriceAudit.cloud.planSourcePath},
    });
  }
  if (!freshCouponEvidenceSupersedesLegacy) {
    for (const f of couponSubmitDryRun.identityFailures || []) addBlocker(blockers, 'store_identity_failure', `${f.store} 身份校验失败`, f);
  }
  if (lowPriceOverlap.activeCouponOutsideAllowedPlanOverlap > 0) {
    addBlocker(
      blockers,
      'active_coupon_outside_allowed_plan',
      `实时 15% 券 active 集合中有 ${lowPriceOverlap.activeCouponOutsideAllowedPlanOverlap} 个商品既不在允许配套计划，又与普通活动/限时折扣价格层重叠`,
      {samples: (lowPriceOverlap.activeCouponOutsideAllowedPlanOverlapRows || []).slice(0, 20)},
    );
  }
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
  if (couponNonGuaranteedFallbackGaps.total > 0) {
    contextWarnings.push({
      code: 'coupon_non_guaranteed_limited_fallback_gaps_remaining',
      label: 'couponNonGuaranteedFallbackGaps',
      message: `优惠券非保底迁移后仍有 ${couponNonGuaranteedFallbackGaps.total} 个店铺+SKC 未完成限时折扣兜底；多为库存/平台规则/已有折扣冲突，不能硬写，但必须继续观察`,
      evidence: {
        sourcePath: couponNonGuaranteedFallbackGaps.sourcePath,
        byBucket: couponNonGuaranteedFallbackGaps.byBucket,
        byStore: couponNonGuaranteedFallbackGaps.byStore,
        lowOrderHitCount: couponNonGuaranteedFallbackGaps.lowOrderHitCount,
        samples: couponNonGuaranteedFallbackGaps.samples,
      },
    });
  }
  if (ordinaryEnrollmentOpenIssues.issueCount > 0 || ordinaryEnrollmentOpenIssues.missingFillEvidence > 0) {
    contextWarnings.push({
      code: 'ordinary_enrollment_price_evidence_open_issues',
      label: 'ordinaryEnrollmentOpenIssues',
      message: `普通活动补报仍有 ${ordinaryEnrollmentOpenIssues.issueCount} 行价格/填价证据待回读，其中缺本轮填价证据 ${ordinaryEnrollmentOpenIssues.missingFillEvidence} 行；不影响已报集合存在，但不能当作价格完全验收`,
      evidence: {
        sourcePath: ordinaryEnrollmentOpenIssues.sourcePath,
        plannedRows: ordinaryEnrollmentOpenIssues.plannedRows,
        enrolledOrUnderReview: ordinaryEnrollmentOpenIssues.enrolledOrUnderReview,
        fillVerified: ordinaryEnrollmentOpenIssues.fillVerified,
        platformAdjusted: ordinaryEnrollmentOpenIssues.platformAdjusted,
        issueRows: ordinaryEnrollmentOpenIssues.issueRows,
      },
    });
  }
  if (ordinaryEnrollmentSupplementOpenIssues.pricePendingRows > 0 || ordinaryEnrollmentSupplementOpenIssues.extraAvailableRows > 0) {
    contextWarnings.push({
      code: 'ordinary_enrollment_supplement_open_issues',
      label: 'ordinaryEnrollmentSupplementOpenIssues',
      message: `XC/45219 补报仍有 ${ordinaryEnrollmentSupplementOpenIssues.pricePendingRows} 行活动价待回读、${ordinaryEnrollmentSupplementOpenIssues.extraAvailableRows} 行计划外可报但缺成本/标准目录证据；不能当作价格完全验收`,
      evidence: {
        sourcePath: ordinaryEnrollmentSupplementOpenIssues.sourcePath,
        action: ordinaryEnrollmentSupplementOpenIssues.action,
        pricePendingSamples: ordinaryEnrollmentSupplementOpenIssues.pricePendingSamples,
        extraAvailableSamples: ordinaryEnrollmentSupplementOpenIssues.extraAvailableSamples,
      },
    });
  }
  if (couponTrafficIntent.enabled && couponBudget.belowTargetCount > 0) {
    addBlocker(
      blockers,
      'coupon_budget_below_target',
      `${couponBudget.belowTargetCount} 个店铺可选流量券预算低于 ${couponBudget.targetBudget} ${couponBudget.currency}`,
      {stores: couponBudget.belowTargetStores},
    );
  }
  if (couponTrafficIntent.enabled && couponBudget.missingEvidenceCount > 0) {
    addBlocker(
      blockers,
      'coupon_budget_missing_evidence',
      `${couponBudget.missingEvidenceCount} 个店铺缺少可选流量券预算 fresh execute 或 read-only current 回读证据`,
      {
        selectedSource: couponBudget.selectedSource,
        stores: couponBudget.missingEvidenceStores,
        executeSource: couponBudget.evidenceSource,
        dryRunSource: couponBudget.dryRunSource,
      },
    );
  }
  if (!couponTrafficIntent.enabled && (couponBudget.belowTargetCount > 0 || couponBudget.missingEvidenceCount > 0)) {
    contextWarnings.push({
      code: 'coupon_budget_observation_only_without_traffic_coupon_targets',
      label: 'couponBudget',
      message: '当前计划没有明确可选流量券目标；优惠券预算缺证据/低预算只作为观察项，不阻塞价格止损或普通活动判断。',
      evidence: {
        belowTargetCount: couponBudget.belowTargetCount,
        missingEvidenceCount: couponBudget.missingEvidenceCount,
        selectedSource: couponBudget.selectedSource,
      },
    });
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
    highClickLowConversionSpecial,
    highClickSpecialEffect,
    orderPriceAudit,
    limitedDiscountTargetPriceDrift,
    manualSpecialLimitedDiscount,
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
    targetPlanSelection: {
      strategy: args.planSelection?.strategy || '',
      targetPlan: rel(args.targetPlan),
      priceOverrides: rel(args.priceOverrides),
      rowCount: args.planSelection?.rowCount ?? null,
      score: args.planSelection?.score ?? null,
      scoreReasons: args.planSelection?.scoreReasons || [],
      rejectedCandidates: args.planSelection?.rejectedCandidates || [],
    },
    marketingStackReviewFreshness: marketingStackReviewContext || null,
    marketingStackReviewSourceSelection: stackReviewSelection,
    marketingStackReviewCoverage,
    t3MarketingCandidates,
    t3MarketingHandledRows,
    couponBudget,
    couponTrafficIntent,
    couponNonGuaranteedFallbackGaps,
    mandatoryLimitedDiscountStatus,
    ordinaryEnrollmentOpenIssues,
    ordinaryEnrollmentSupplementOpenIssues,
    budgetReadback: budgetReadback.source.status === 'missing'
      ? {status: 'unknown', reason: 'no coupon budget readback source found'}
      : {status: budgetReadback.source.status, path: budgetReadback.source.path},
    optionalTrafficCouponReview,
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
    && !report.highClickLowConversionSpecial.actionCount
    && !report.highClickLowConversionSpecial.blockedCount
    && !report.couponNonGuaranteedFallbackGaps.total
    && !report.ordinaryEnrollmentOpenIssues.issueCount
    && !report.ordinaryEnrollmentOpenIssues.missingFillEvidence
    && !report.ordinaryEnrollmentSupplementOpenIssues.pricePendingRows
    && !report.ordinaryEnrollmentSupplementOpenIssues.extraAvailableRows
    && !report.aboveTargetActions.count
    && !report.lowPriceOverlap.belowTarget
    && !report.lowPriceOverlap.missingEvidence
    && !report.lowPriceOverlap.cancelRows
    && !report.oldOrdinaryOverlap.riskCancel
    && !report.oldOrdinaryOverlap.cancelRows
    && !report.orderPriceAudit.below
    && !report.orderPriceAudit.above
    && !report.orderPriceAudit.dataQualityRows
    && !report.manualSpecialLimitedDiscount.actionCount
    && report.orderPriceAudit.cloud?.status === 'ok'
    && !report.orderPriceAudit.cloud?.missingFileCount
    && !report.orderPriceAudit.cloud?.parseErrorFileCount
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
