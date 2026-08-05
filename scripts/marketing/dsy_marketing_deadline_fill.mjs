#!/usr/bin/env node
// SHEIN 营销活动报名半自动助手：
// - 只做商品勾选、活动价/降幅预填和页面复核。
// - 默认不点击最终“提交报名”；只有显式传入 --submit 且选择/填价复核通过后才会提交。
// - 运行前先执行 scripts/marketing/build_marketing_cost_map.py 生成本地成本映射。
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {normalizeGoodsSnDetailed} from '../../lib/product_sku_normalizer.mjs';
import {
  buildExposureTopLinkIndex,
  loadMarketingPricingPolicy,
  pctConfigToRatio,
  resolveExposureAdjustedMargin,
  readJsonIfExists,
} from '../../lib/marketing_pricing_policy.mjs';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';
import {
  assertOrdinaryCampaignApprovedSubset,
  loadOrdinaryCampaignApproval,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';
import {
  buildOrdinaryPlatformPriceAdjustmentAudit,
  isOrdinaryPlatformTierRewriteAccepted,
} from '../../lib/marketing_ordinary_platform_price_policy.mjs';
import {
  applyLowEtFastSellerPricePullbackToRows,
  buildLowEtFastSellerPricingContext,
} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {assertCloudMarketingWriteGate} from '../../lib/cloud_marketing_write_gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const STORES = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8')).stores;
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const COST_DOC = JSON.parse(await fs.readFile(path.join(ROOT, 'tmp', 'mbrs', 'marketing-cost-map.json'), 'utf8'));
const COSTS = COST_DOC.costMap || {};
const TRUE_COSTS = COST_DOC.trueCostMap || {};
const args = parseArgs(process.argv.slice(2));
if (args.submit) assertCloudMarketingWriteGate();
const EXECUTION_APPROVAL = await loadExecutionApproval();
const OUT_DIR = args.outDir ? path.resolve(args.outDir) : path.join(ROOT, 'tmp', 'mbrs', 'deadline-fill-results');
await fs.mkdir(OUT_DIR, {recursive: true});
const now = new Date();
const deadlineMs = now.getTime() + (args.hours * 3600_000);
const PRICING_POLICY = await loadMarketingPricingPolicy(args.pricingPolicy);
const PRICING_BI = await readJsonIfExists(args.bi, null);
const INVENTORY_TREND = await readJsonIfExists(args.inventoryTrend, null);
const EXPOSURE_INDEX = buildExposureTopLinkIndex(PRICING_BI, PRICING_POLICY);

const DEFAULT_MARGIN_TARGET = 0.30;
const FIXED_PRICE_JITTER = {min: -2, max: 1};
const MARGIN_TARGET_JITTER = {min: -0.02, max: 0.01};
const COUPON_FINAL_PRICE_TOLERANCE_SAR = 1;

// P0-#4 fix: load fallback prices from config instead of hardcoding in source.
const FALLBACK_PRICE_CONFIG = JSON.parse(
  await fs.readFile(path.join(ROOT, 'config', 'marketing_fallback_prices.json'), 'utf8')
);
const fixedPriceBase = Object.entries(FALLBACK_PRICE_CONFIG.fixedPrices || {});
const marginRuleBase = Object.entries(FALLBACK_PRICE_CONFIG.marginRules || {})
const fixedPriceRules = new Map();
const marginRules = new Map();
const priceOverrideRules = new Map();
const storePriceOverrideRules = new Map();
const rowPriceOverrideRules = new Map();
const selectionAllowRules = new Map();
let LOW_ET_PRICE_PULLBACK = {
  enabled: PRICING_POLICY?.lowEtFastSellerPricePullback?.enabled !== false,
  evidenceHash: '',
  appliedCount: 0,
  blockedCount: 0,
  manualReviewCount: 0,
  results: [],
};

function registerRuleKeys(map, label, value) {
  const keys = [
    compact(label),
    compact(normalizeGoodsSnDetailed(label, {goodsTitle: label}).canonical),
    compact(modelCode(label)),
  ].filter(Boolean);
  for (const key of keys) map.set(key, value);
}

for (const [label, value] of fixedPriceBase) registerRuleKeys(fixedPriceRules, label, value);
for (const [label, value] of marginRuleBase) registerRuleKeys(marginRules, label, value);
await loadSelectionPlan();
await loadPriceOverrides();

function parseArgs(argv) {
  const out = {
    stores: [],
    activityIds: [],
    hours: 48,
    allOpen: false,
    includeCoupon: false,
    dryRun: false,
    noClose: false,
    headless: false,
    runtimePort: null,
    selectionDebugOnly: false,
    fillDebugSkc: '',
    allowUneditableSkcs: [],
    submit: false,
    minDiscountFallback: [],
    priceOverrides: '',
    selectionPlan: '',
    pricingPolicy: path.join(ROOT, 'config', 'marketing_pricing_policy.json'),
    bi: path.join(ROOT, 'outputs', 'bi-portal', 'data.json'),
    inventoryTrend: path.join(ROOT, 'outputs', 'bi-portal', 'sections', 'inventoryTrend.json'),
    outDir: '',
    executionWorkFingerprint: '',
    expectedLowEtEvidenceHash: '',
    approvalManifest: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores = String(argv[++i] || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--activity') out.activityIds = String(argv[++i] || '').split(',').map(s => Number(s.trim())).filter(Boolean);
    else if (a === '--hours') out.hours = Number(argv[++i] || 48);
    else if (a === '--all-open') out.allOpen = true;
    else if (a === '--include-coupon') out.includeCoupon = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-close') out.noClose = true;
    else if (a === '--headless') out.headless = true;
    else if (a === '--runtime-port') out.runtimePort = Number(argv[++i] || 0);
    else if (a === '--selection-debug-only') out.selectionDebugOnly = true;
    else if (a === '--fill-debug-skc') out.fillDebugSkc = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--allow-uneditable-skc') out.allowUneditableSkcs = String(argv[++i] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    else if (a === '--submit') out.submit = true;
    else if (a === '--min-discount-fallback') out.minDiscountFallback = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--price-overrides') out.priceOverrides = path.resolve(argv[++i] || '');
    else if (a === '--selection-plan') out.selectionPlan = path.resolve(argv[++i] || '');
    else if (a === '--pricing-policy') out.pricingPolicy = path.resolve(argv[++i] || '');
    else if (a === '--bi') out.bi = path.resolve(argv[++i] || '');
    else if (a === '--inventory-trend') out.inventoryTrend = path.resolve(argv[++i] || '');
    else if (a === '--out-dir') out.outDir = path.resolve(argv[++i] || '');
    else if (a === '--execution-work-fingerprint') out.executionWorkFingerprint = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--expected-low-et-evidence-hash') out.expectedLowEtEvidenceHash = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--approval-manifest') out.approvalManifest = path.resolve(argv[++i] || '');
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.executionWorkFingerprint && !/^[a-f0-9]{64}$/.test(out.executionWorkFingerprint)) {
    throw new Error('Invalid --execution-work-fingerprint');
  }
  if (out.expectedLowEtEvidenceHash && !/^[a-f0-9]{64}$/.test(out.expectedLowEtEvidenceHash)) {
    throw new Error('Invalid --expected-low-et-evidence-hash');
  }
  return out;
}

async function loadExecutionApproval() {
  if (args.submit && !args.approvalManifest) {
    throw new Error('--submit requires --approval-manifest; a filename containing approved is not authorization');
  }
  if (!args.approvalManifest) return null;
  if (!args.selectionPlan || !args.priceOverrides) {
    throw new Error('--approval-manifest requires --selection-plan and --price-overrides');
  }
  const approval = await loadOrdinaryCampaignApproval({
    root: ROOT,
    manifestPath: args.approvalManifest,
  });
  const [selection, prices] = await Promise.all([
    fs.readFile(args.selectionPlan, 'utf8').then(JSON.parse),
    fs.readFile(args.priceOverrides, 'utf8').then(JSON.parse),
  ]);
  assertOrdinaryCampaignApprovedSubset(approval, selection, prices);
  if (args.executionWorkFingerprint && args.executionWorkFingerprint !== approval.workFingerprint) {
    throw new Error(`--execution-work-fingerprint does not match approval manifest: expected=${approval.workFingerprint} actual=${args.executionWorkFingerprint}`);
  }
  args.executionWorkFingerprint = approval.workFingerprint;
  return approval;
}

function compact(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[()（）【】\[\]_:：/\\]/g, '').toUpperCase();
}

function formatShanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function modelCode(s) {
  return String(s || '').match(/^[A-Z]{1,5}-?\d+[A-Z]?(?:-\d+)?/i)?.[0] || '';
}

async function loadPriceOverrides() {
  if (!args.priceOverrides) return;
  const doc = JSON.parse(await fs.readFile(args.priceOverrides, 'utf8'));
  const lowEtContext = buildLowEtFastSellerPricingContext({
    inventoryTrendDoc: INVENTORY_TREND,
    linksDataDoc: PRICING_BI,
    baselineDoc: doc,
    costDoc: COST_DOC,
    marketingPolicy: PRICING_POLICY,
    reportDate: formatShanghaiDate(now),
  });
  const adjusted = applyLowEtFastSellerPricePullbackToRows({
    rows: Array.isArray(doc.items) ? doc.items : [],
    context: lowEtContext,
    costDoc: COST_DOC,
    isManualSpecial: item => item?.manualSpecialLimitedDiscount === true,
  });
  LOW_ET_PRICE_PULLBACK = {
    enabled: lowEtContext.policy.enabled !== false,
    evidenceHash: lowEtContext.evidenceHash,
    appliedCount: adjusted.appliedCount,
    blockedCount: adjusted.blockedCount,
    manualReviewCount: adjusted.manualReviewCount,
    blockers: lowEtContext.blockers,
    results: adjusted.results.map(result => ({
      storeKey: result.row?.storeKey || '',
      skc: result.row?.skc || '',
      canonical: result.row?.canonical || result.evidence?.canonical || '',
      applied: result.applied === true,
      blocked: result.blocked === true,
      manualReview: result.manualReview === true,
      reason: result.reason,
      finalTargetPrice: result.row?.finalTargetPrice ?? result.row?.targetPrice ?? null,
      audit: result.audit || null,
    })),
  };
  if (args.submit) {
    if (!args.expectedLowEtEvidenceHash) {
      throw new Error('--submit requires --expected-low-et-evidence-hash from the immediately preceding dry-run');
    }
    if (args.expectedLowEtEvidenceHash !== lowEtContext.evidenceHash) {
      throw new Error(`low ET pricing evidence drift: expected=${args.expectedLowEtEvidenceHash} actual=${lowEtContext.evidenceHash}`);
    }
    const unsafe = adjusted.results.filter(result => (
      (result.blocked || result.manualReview)
      && isSelectedPriceRow(result.row)
    ));
    if (unsafe.length) {
      throw new Error(`low ET pricing fail-closed rows=${unsafe.length}: ${unsafe.slice(0, 5).map(result => `${result.row?.storeKey || ''}/${result.row?.skc || ''}:${result.reason}`).join(',')}`);
    }
  }
  const items = adjusted.rows;
  for (const item of items) {
    const label = item.canonical || item.goodsSn || item.supplierNo || '';
    if (!label || item.targetPrice === undefined || item.targetPrice === null) continue;
    const storeKeys = [
      ...(Array.isArray(item.storeKeys) ? item.storeKeys : []),
      ...(item.storeKey ? [item.storeKey] : []),
    ].map(x => String(x || '').trim().toUpperCase()).filter(Boolean);
    if (item.storeKey && item.activityId && item.skc) {
      rowPriceOverrideRules.set(`${String(item.storeKey).trim().toUpperCase()}:${Number(item.activityId)}:${String(item.skc).trim().toLowerCase()}`, item);
    }
    if (storeKeys.length) {
      const before = new Map();
      registerRuleKeys(before, label, item);
      for (const key of item.keys || []) before.set(compact(key), item);
      for (const storeKey of storeKeys) {
        for (const key of before.keys()) storePriceOverrideRules.set(`${storeKey}:${key}`, item);
      }
    } else {
      registerRuleKeys(priceOverrideRules, label, item);
      for (const key of item.keys || []) priceOverrideRules.set(compact(key), item);
    }
  }
}

function isSelectedPriceRow(row) {
  if (!args.selectionPlan) return true;
  const storeKey = String(row?.storeKey || '').trim().toUpperCase();
  const activityId = Number(row?.activityId || 0);
  const skc = String(row?.skc || '').trim().toLowerCase();
  if (!storeKey || !activityId || !skc) return false;
  return selectionAllowRules.get(`${storeKey}:${activityId}`)?.has(skc) === true;
}

async function loadSelectionPlan() {
  if (!args.selectionPlan) return;
  const doc = JSON.parse(await fs.readFile(args.selectionPlan, 'utf8'));
  const items = Array.isArray(doc.items) ? doc.items : [];
  for (const item of items) {
    if (item.selected === false) continue;
    const storeKey = String(item.storeKey || '').trim().toUpperCase();
    const activityId = Number(item.activityId || 0);
    const skc = String(item.skc || '').trim().toLowerCase();
    if (!storeKey || !activityId || !skc) continue;
    const key = `${storeKey}:${activityId}`;
    if (!selectionAllowRules.has(key)) selectionAllowRules.set(key, new Set());
    selectionAllowRules.get(key).add(skc);
  }
}

function selectionAllowList(storeKey, activityId) {
  const set = selectionAllowRules.get(`${String(storeKey).trim().toUpperCase()}:${Number(activityId)}`);
  return set ? [...set].sort() : null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function floor2(n) {
  return Math.floor((Number(n) + 1e-9) * 100) / 100;
}

function numValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace('%', '').replace(',', '').trim());
  return Number.isFinite(n) ? n : null;
}

function platformAdjustedCouponRisk(rule, target, platformAdjusted) {
  if (!platformAdjusted || !rule) return null;
  const couponFactor = numValue(rule.couponFactor);
  const finalTargetPrice = numValue(rule.finalTargetPrice ?? rule.intendedFinalTargetPrice);
  if (couponFactor === null || couponFactor >= 0.999) return null;
  if (finalTargetPrice === null || finalTargetPrice <= 0) return null;
  const projectedFinalPrice = round2(Number(target) * couponFactor);
  if (projectedFinalPrice < finalTargetPrice - COUPON_FINAL_PRICE_TOLERANCE_SAR) {
    return {
      couponStackRisk: true,
      couponStackRiskType: 'platform_minimum_tier_coupon_final_below_target',
      couponStackRiskReason: '普通活动按平台最低档报名后，若再叠加计划券，预计成交价会低于原目标价；普通活动继续报名并单列风险',
      couponFactor,
      finalTargetPrice,
      projectedFinalPrice,
      activityTargetAfterPlatformAdjust: round2(target),
      toleranceSar: COUPON_FINAL_PRICE_TOLERANCE_SAR,
    };
  }
  return null;
}

function stableRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function randomBetween(seed, min, max) {
  return min + stableRandom(seed) * (max - min);
}

function findManualRule(keys) {
  for (const k of keys) {
    if (fixedPriceRules.has(k)) {
      return {
        ruleType: 'fixed_price',
        source: 'fixed_price',
        base: Number(fixedPriceRules.get(k)),
        marginTarget: null,
      };
    }
    if (marginRules.has(k)) {
      const marginTarget = Number(marginRules.get(k));
      return {
        ruleType: 'margin',
        source: `${Math.round(marginTarget * 100)}pct_profit`,
        base: null,
        marginTarget,
      };
    }
  }
  return null;
}

function discountPctForTarget(current, minDiscount, target) {
  if (!(current > 0)) return minDiscount;
  const raw = (1 - target / current) * 100;
  const pct = Math.floor(raw + 1e-9);
  return Math.max(minDiscount, pct);
}

function parseTime(s) {
  if (!s || s === '长期有效') return null;
  const raw = String(s).trim();
  const d = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
    ? new Date(raw.replace(/\//g, '-').replace(' ', 'T'))
    : new Date(raw.replace(/\//g, '-').replace(' ', 'T') + '+08:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') {
    const cleanup = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'cleanup_shein_store_browsers.mjs'),
      '--store',
      store.storeKey,
      '--kill-after-sec',
      '5',
    ], {cwd: ROOT, encoding: 'utf8', timeout: 15_000});
    if (cleanup.status !== 0) {
      console.warn(`[${store.storeKey}] 云端浏览器收口失败：${cleanup.stderr || cleanup.stdout || `exit=${cleanup.status}`}`);
    }
    return;
  }
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchVisible(store) {
  const r = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    args.headless ? '--headless' : '--visible',
    '--port',
    String(store.port),
    '--url',
    LIST_URL,
  ], {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) {
    throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
  }
}

async function waitForDebugPort(store, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await httpJson(`http://127.0.0.1:${store.port}/json/version`);
      return true;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Chrome debug port not ready for ${store.storeKey} on ${store.port}: ${lastError?.message || 'timeout'}`);
}

function bringStoreWindowToFront(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type @\"",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public class Win32BringToFront {",
    "  [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);",
    "  [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);",
    "}",
    "\"@",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$rootIds = @(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" } | Select-Object -ExpandProperty ProcessId)",
    "$wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and ($rootIds -contains $_.Id) })",
    "if (-not $wins -or $wins.Count -eq 0) { $wins = @(Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*SHEIN*' }) }",
    "$p = $wins | Select-Object -First 1",
    "if ($p) { [Win32BringToFront]::ShowWindowAsync($p.MainWindowHandle, 3) | Out-Null; Start-Sleep -Milliseconds 200; [Win32BringToFront]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }",
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return await res.json();
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, {once: true});
      this.ws.addEventListener('error', reject, {once: true});
    });
    this.ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject, timer} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  call(method, params = {}, sessionId = undefined) {
    const id = ++this.id;
    const payload = {id, method, params};
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      const timeoutMs = method === 'Runtime.evaluate' ? 300_000 : 30_000;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStore(store) {
  await waitForDebugPort(store);
  const version = await httpJson(`http://127.0.0.1:${store.port}/json/version`);
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  cdp.port = store.port;
  await cdp.connect();
  return cdp;
}

async function newPage(cdp, url) {
  const {targetId} = await cdp.call('Target.createTarget', {url, newWindow: false});
  const {sessionId} = await cdp.call('Target.attachToTarget', {targetId, flatten: true});
  await cdp.call('Runtime.enable', {}, sessionId);
  await cdp.call('Page.enable', {}, sessionId);
  try {
    const win = await cdp.call('Browser.getWindowForTarget', {targetId});
    await cdp.call('Browser.setWindowBounds', {windowId: win.windowId, bounds: {windowState: 'maximized'}});
  } catch {}
  return {targetId, sessionId};
}

async function evalJs(cdp, sessionId, body, arg = undefined) {
  const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
  const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
  const res = await cdp.call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }, sessionId);
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description
      || res.exceptionDetails.exception?.value
      || res.exceptionDetails.text
      || JSON.stringify(res.exceptionDetails)
    );
  }
  return res.result?.value;
}

async function assertCurrentStoreIdentity(cdp, sessionId, store, context) {
  const identitySnapshot = await evalJs(cdp, sessionId, storeIdentityEvalBody());
  return requireStoreIdentitySnapshot({
    store,
    truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey],
    snapshot: identitySnapshot,
    context,
  });
}

async function recoverLoginIfNeeded(cdp, sessionId) {
  return await recoverSheinLoginIfNeeded({
    evaluate: (body, arg) => evalJs(cdp, sessionId, body, arg),
    dispatchMouseEvent: params => cdp.call('Input.dispatchMouseEvent', params, sessionId),
    reload: () => cdp.call('Page.reload', {ignoreCache: true}, sessionId).catch(() => evalJs(cdp, sessionId, `location.reload(); return {href: location.href};`)),
    sleep,
    maxAttempts: 3,
  });
}

async function waitForActivityOrLogin(cdp, sessionId, timeoutMs = 35_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evalJs(cdp, sessionId, `
      const text = document.body?.innerText || '';
      const activityReady = (
        text.includes('可报名商品') ||
        text.includes('选择商品') ||
        text.includes('提报的活动价格') ||
        text.includes('不可报名商品') ||
        text.includes('下一步') ||
        /总计\\s*\\d+\\s*个/.test(text)
      );
      const loginReady = location.href.includes('/login/')
        || text.includes('请输入账号')
        || text.includes('请输入密码')
        || (text.includes('账号登录') && text.includes('密码') && text.includes('登录'));
      const renderError = text.includes('渲染异常，请刷新页面后重试')
        || text.includes("application '/mbrs' died in status LOADING_SOURCE_CODE")
        || text.includes('Failed to load script for "/mbrs"');
      return {activityReady, loginReady, renderError, href: location.href, title: document.title || '', tail: text.slice(-800)};
    `).catch(err => ({activityReady: false, loginReady: false, error: err.message, href: '', tail: ''}));
    if (state.activityReady || state.loginReady || state.renderError) return state;
    await sleep(500);
  }
  return {activityReady: false, loginReady: false, timeout: true};
}

async function waitFor(cdp, sessionId, predicateBody, timeoutMs = 25_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await evalJs(cdp, sessionId, `return Boolean(${predicateBody});`).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function realClick(cdp, sessionId, rect) {
  if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return false;
  const x = rect.x + (rect.w || 0) / 2;
  const y = rect.y + (rect.h || 0) / 2;
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', x, y, button: 'none'}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mousePressed', x, y, button: 'left', clickCount: 1}, sessionId);
  await cdp.call('Input.dispatchMouseEvent', {type: 'mouseReleased', x, y, button: 'left', clickCount: 1}, sessionId);
  return true;
}

async function setPageSize500(cdp, sessionId) {
  const before = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
    const totalText = ([...document.querySelectorAll('*')].map(textOf).find(t => /总计\\s*\\d+\\s*个/.test(t)) || '');
    const totalGoods = Number((totalText.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0);
    const current = [...document.querySelectorAll('.soui-pagination-size-list, .soui-select-wrapper, div, span')]
      .filter(el => /\\d+\\s*条\\/页/.test(textOf(el)))
      .sort((a,b) => {
        const score = el => {
          const cls = String(el.className || '');
          if (cls.includes('soui-pagination-size-list')) return 0;
          if (cls.includes('soui-select-wrapper')) return 1;
          return 2;
        };
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (score(a) - score(b)) || (br.y - ar.y) || (br.x - ar.x);
      })[0];
    return {
      totalGoods,
      currentText: textOf(current),
      rect: current ? rectOf(current) : null,
    };
  `);
  if (!before?.rect) return {ok: false, skipped: true, reason: '未找到每页条数控件', ...before};
  if (/500\s*条\/页/.test(before.currentText || '')) return {ok: true, changed: false, ...before};
  const centeredRect = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const current = [...document.querySelectorAll('.soui-pagination-size-list, .soui-select-wrapper, div, span')]
      .filter(el => /\\d+\\s*条\\/页/.test(textOf(el)))
      .sort((a,b) => {
        const score = el => String(el.className || '').includes('soui-pagination-size-list') ? 0 : (String(el.className || '').includes('soui-select-wrapper') ? 1 : 2);
        return (score(a) - score(b)) || (b.getBoundingClientRect().y - a.getBoundingClientRect().y);
      })[0];
    if (!current) return false;
    current.scrollIntoView({block:'center', inline:'center'});
    const r = current.getBoundingClientRect();
    return {x: r.left, y: r.top, w: r.width, h: r.height};
  `);
  await realClick(cdp, sessionId, centeredRect || before.rect);
  await sleep(500);
  const option = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      return {x: r.left, y: r.top, w: r.width, h: r.height};
    };
    const options = [...document.querySelectorAll('li, div, span')]
      .filter(el => /^500\\s*条\\/页$/.test(textOf(el)))
      .map(el => ({el, rect: rectOf(el), text: textOf(el), cls: String(el.className || '')}))
      .filter(x => x.rect.w > 0 && x.rect.h > 0)
      .sort((a,b) => {
        const score = x => (x.el.tagName === 'LI' ? 0 : 1) + (String(x.cls).includes('soui-select-option') ? -1 : 0);
        return score(a) - score(b);
      });
    const picked = options[0];
    return picked ? {text: picked.text, rect: picked.rect, cls: picked.cls} : null;
  `);
  if (!option?.rect) return {ok: false, changed: false, reason: '未找到500条/页选项', before};
  await realClick(cdp, sessionId, option.rect);
  await sleep(1200);
  const after = await evalJs(cdp, sessionId, `
    const textOf = el => String(el?.innerText || el?.textContent || '').replace(/\\s+/g, ' ').trim();
    const sizeText = ([...document.querySelectorAll('.soui-pagination-size-list, .soui-select-wrapper, div, span')]
      .map(textOf)
      .find(t => /^500\\s*条\\/页$/.test(t)) || '');
    const totalText = ([...document.querySelectorAll('*')].map(textOf).find(t => /总计\\s*\\d+\\s*个/.test(t)) || '');
    const totalGoods = Number((totalText.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0);
    return {sizeText, totalGoods};
  `);
  return {ok: /500\s*条\/页/.test(after?.sizeText || ''), changed: true, before, optionText: option.text, after};
}

async function fetchActivities(cdp, sessionId) {
  await waitFor(cdp, sessionId, `document.body && (document.body.innerText.includes('营销活动报名') || document.body.innerText.includes('活动'))`, 30_000);
  const expectedIds = args.activityIds.map(Number).filter(Boolean);
  let pages = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    pages = await evalJs(cdp, sessionId, `
      const pages = [];
      for (let page = 1; page <= 20; page += 1) {
        const r = await fetch('/mrs-api-prefix/mbrs/activity/get_activity_list?page_num=' + page + '&page_size=100', {
          method: 'POST',
          credentials: 'include',
          headers: {'content-type': 'application/json'},
          body: '{}',
        });
        const json = await r.json();
        const list = json?.info?.activity_detail_list || [];
        pages.push({page, code: json?.code, msg: json?.msg, totalCount: json?.info?.total_count ?? null, list});
        if (list.length < 100) break;
      }
      return pages;
    `).catch(err => [{page: 0, code: 'ERR', msg: err.message, totalCount: null, list: []}]);
    const flat = (pages || []).flatMap(p => p.list || []);
    const ids = new Set(flat.map(a => Number(a.activity_id)).filter(Boolean));
    const hasExpected = expectedIds.length ? expectedIds.some(id => ids.has(id)) : flat.length > 0;
    if (flat.length > 0 && hasExpected) break;
    await sleep(1500);
  }
  const seen = new Set();
  const list = [];
  for (const page of pages || []) {
    for (const activity of page.list || []) {
      const id = Number(activity.activity_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push(activity);
    }
  }
  return list.map(a => ({
    activityId: Number(a.activity_id),
    name: a.activity_name || '',
    backendCate: a.backend_cate,
    label: a.text_tag_content || '',
    signStart: a.activity_start_zone_time || '',
    signEnd: a.activity_end_zone_time || '',
    eventStart: a.start_zone_time || '',
    eventEnd: a.end_zone_time || '',
    allowGoodsNum: Number(a.allow_goods_num || 0),
    applyGoodsNum: Number(a.apply_goods_num || 0),
    raw: a,
  }));
}

async function cleanupStorePages(cdp, keepTargetIds = []) {
  const keep = new Set(keepTargetIds.filter(Boolean));
  const targets = await httpJson(`http://127.0.0.1:${cdp.port}/json/list`).catch(() => []);
  for (const target of targets) {
    if (target.type !== 'page') continue;
    if (keep.has(target.id)) continue;
    if (!/sso\.geiwohuo\.com/.test(target.url || '')) continue;
    await cdp.call('Target.closeTarget', {targetId: target.id}).catch(() => {});
  }
}

function isCouponActivity(a) {
  const text = [a.name, a.label, a.backendCate].filter(Boolean).join(' ');
  return /coupon|优惠券/i.test(text);
}

function withinDeadline(a) {
  if (args.activityIds.length && !args.activityIds.includes(a.activityId)) return false;
  if (!args.includeCoupon && isCouponActivity(a)) return false;
  if (!args.activityIds.length) {
    if (a.allowGoodsNum <= 0) return false;
    if (a.applyGoodsNum >= a.allowGoodsNum) return false;
  }
  const end = parseTime(a.signEnd);
  if (!end) return false;
  if (end.getTime() < now.getTime()) return false;
  if (args.activityIds.length || args.allOpen) return true;
  return end.getTime() <= deadlineMs;
}

function specifiedActivities(liveActivities) {
  if (!args.activityIds.length) return liveActivities.filter(withinDeadline);
  const byId = new Map(liveActivities.map(a => [Number(a.activityId), a]));
  return args.activityIds.map(activityId => byId.get(Number(activityId)) || {
    activityId: Number(activityId),
    name: `specified activity ${activityId}`,
    backendCate: '',
    label: '',
    signStart: '',
    signEnd: '',
    eventStart: '',
    eventEnd: '',
    allowGoodsNum: 0,
    applyGoodsNum: 0,
    raw: null,
    source: 'specified_activity_fallback',
  });
}

function dueActivities(activities) {
  return args.activityIds.length ? specifiedActivities(activities) : activities.filter(withinDeadline);
}

async function preselectSingleSkcViaCdp(cdp, sessionId, wantedSkc) {
  const wanted = String(wantedSkc || '').trim().toLowerCase();
  if (!wanted) return {attempted: false, selected: false};
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await evalJs(cdp, sessionId, `
      const wanted = __arg.wanted;
      const attempt = __arg.attempt;
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const selectedText = [...document.querySelectorAll('*')]
        .filter(visible)
        .map(el => el.innerText || '')
        .find(text => /已选商品\d+个/.test(text)) || '';
      const selectedCount = Number((selectedText.match(/已选商品(\d+)个/) || [])[1] || 0);
      const row = [...document.querySelectorAll('tbody tr')].find(tr => {
        const skc = String(((tr.innerText || '').match(/SKC:\s*([a-z]{2}\d+)/i) || [])[1] || '').toLowerCase();
        return skc === wanted;
      });
      if (row) {
        row.scrollIntoView({block:'center', inline:'nearest'});
        const cell = row.querySelector('td:first-child');
        const hoverTarget = cell?.querySelector('div') || cell || row;
        for (const type of ['mouseenter','mouseover','mousemove']) {
          hoverTarget.dispatchEvent(new MouseEvent(type, {bubbles:true, cancelable:true, view:window}));
        }
        const rect = (row.querySelector('input[type=checkbox]')?.closest('.soui-checkbox-wrapper,.merchant-ui-checkbox') || cell || row).getBoundingClientRect();
        return {selectedCount, found:true, rect:{x:rect.left,y:rect.top,w:rect.width,h:rect.height}};
      }
      const roots = [document.scrollingElement, ...document.querySelectorAll('div,main,section')]
        .filter(Boolean)
        .filter((root, index, all) => all.indexOf(root) === index)
        .filter(root => root.scrollHeight > root.clientHeight + 20)
        .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight))
        .slice(0, 12);
      for (const root of roots) {
        const max = Math.max(0, root.scrollHeight - root.clientHeight);
        const top = Math.min(max, attempt * Math.max(80, Math.floor(Math.max(300, root.clientHeight) * 0.25)));
        if (root === document.scrollingElement) window.scrollTo(0, top);
        else {
          root.scrollTop = top;
          root.dispatchEvent(new Event('scroll', {bubbles:true}));
        }
      }
      return {selectedCount, found:false, rootCount:roots.length};
    `, {wanted, attempt});
    if (state.selectedCount === 1) return {attempted: true, selected: true, attempt, via: 'existing_selection'};
    if (state.found && state.rect) {
      await sleep(250);
      await realClick(cdp, sessionId, state.rect);
      await sleep(500);
      const selectedCount = await evalJs(cdp, sessionId, `
        const text = [...document.querySelectorAll('*')].map(el => el.innerText || '').find(value => /已选商品\d+个/.test(value)) || '';
        return Number((text.match(/已选商品(\d+)个/) || [])[1] || 0);
      `).catch(() => 0);
      if (selectedCount === 1) return {attempted: true, selected: true, attempt, via: 'cdp_row_cell_click'};
    }
    await sleep(300);
  }
  return {attempted: true, selected: false, reason: 'target_row_not_selectable_after_scroll'};
}

async function applyAllowlistBatchFilterViaCdp(cdp, sessionId, allowSkcs) {
  const skcs = [...new Set((allowSkcs || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
  if (!skcs.length) return {attempted: false, matched: false};
  const prepared = await evalJs(cdp, sessionId, `
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const textarea = [...document.querySelectorAll('textarea')]
      .filter(visible)
      .find(el => String(el.getAttribute('placeholder') || '').includes('回车分割'));
    if (!textarea) return {ok:false, reason:'batch_skc_textarea_not_found'};
    let scope = textarea.parentElement;
    for (let depth = 0; scope && depth < 12; depth += 1, scope = scope.parentElement) {
      const hasSearch = [...scope.querySelectorAll('button')]
        .some(button => visible(button) && (button.innerText || button.textContent || '').trim() === '搜索' && !button.disabled);
      if (hasSearch && (scope.innerText || '').includes('商品SKC')) break;
    }
    const button = [...(scope || document).querySelectorAll('button')]
      .filter(visible)
      .find(el => (el.innerText || el.textContent || '').trim() === '搜索' && !el.disabled);
    if (!button) return {ok:false, reason:'batch_skc_search_button_not_found'};
    textarea.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (desc?.set) desc.set.call(textarea, __arg.value); else textarea.value = __arg.value;
    textarea.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:__arg.value}));
    textarea.dispatchEvent(new Event('change', {bubbles:true}));
    textarea.dispatchEvent(new FocusEvent('blur', {bubbles:true}));
    button.scrollIntoView({block:'center', inline:'center'});
    const rect = button.getBoundingClientRect();
    return {ok:true, textareaValue:textarea.value, rect:{x:rect.left,y:rect.top,w:rect.width,h:rect.height}};
  `, {value: `${skcs.join('\n')}\n`});
  if (!prepared?.ok || !prepared.rect) return {attempted: true, matched: false, ...prepared};
  await realClick(cdp, sessionId, prepared.rect);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(250);
    const state = await evalJs(cdp, sessionId, `
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const totals = [...document.querySelectorAll('*')]
        .filter(visible)
        .map(el => el.innerText || '')
        .map(text => Number((text.match(/总计\s*(\d+)\s*个/) || [])[1] || 0))
        .filter(Boolean);
      const totalGoods = totals.length ? Math.max(...totals) : 0;
      const visibleSkcs = [...document.querySelectorAll('tbody tr')]
        .filter(visible)
        .map(tr => String(((tr.innerText || '').match(/SKC:\s*([a-z]{2}\d+)/i) || [])[1] || '').toLowerCase())
        .filter(Boolean);
      return {totalGoods, visibleSkcs};
    `);
    const matched = state.totalGoods === skcs.length
      && state.visibleSkcs.length > 0
      && state.visibleSkcs.every(skc => skcs.includes(skc));
    if (matched) return {attempted: true, matched: true, requested: skcs.length, ...state, prepared};
  }
  return {attempted: true, matched: false, requested: skcs.length, prepared};
}

async function selectAllGoodsAndNext(cdp, sessionId, allowSkcs = null) {
  const ready = await waitFor(cdp, sessionId, `
    document.body && (document.body.innerText.includes('可报名商品') || document.body.innerText.includes('提报的活动价格'))
  `, 30_000);
  if (!ready) return {ok: false, reason: '商品页未加载'};

  const mode = await evalJs(cdp, sessionId, `
    const t = document.body.innerText || '';
    if (t.includes('提报的活动价格')) return 'edit';
    if (t.includes('可报名商品')) return 'choose';
    return 'unknown';
  `);
  if (mode === 'edit') return {ok: true, mode: 'edit'};
  if (mode !== 'choose') return {ok: false, mode, reason: '未知页面'};

  let pageSize = null;
  const pageSizeAttempts = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await cdp.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}, sessionId).catch(() => {});
    await cdp.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27}, sessionId).catch(() => {});
    pageSize = await setPageSize500(cdp, sessionId);
    pageSizeAttempts.push({attempt, ...pageSize});
    if (pageSize?.ok) break;
    await sleep(800);
  }
  pageSize = {...pageSize, attempts: pageSizeAttempts};
  await sleep(500);

  const activityInventoryTransactionPlan = await queryOrdinaryActivityInventoryTransactionPlan(
    cdp,
    sessionId,
    allowSkcs,
  );
  const preselectedSingle = {attempted: false, selected: false, reason: 'batch_skc_textarea_filter_preferred'};
  const prefilteredAllowlist = allowSkcs?.length
    ? await applyAllowlistBatchFilterViaCdp(cdp, sessionId, allowSkcs)
    : {attempted: false, matched: false};

  if (args.selectionDebugOnly) {
    const diagnostic = await evalJs(cdp, sessionId, `
      const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const rowInfo = tr => {
        const text = tr?.innerText || '';
        return {
          skc: String((text.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '').toLowerCase(),
          text: text.slice(0, 260),
        };
      };
      const tbody = document.querySelector('tbody');
      const activityId = Number((location.href.match(/\\/config\\/(\\d+)/) || [])[1] || 0);
      let apiSnapshot = null;
      try {
        const response = await fetch('/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2?page_num=1&page_size=500', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json;charset=UTF-8',
            'Origin-Url': location.href,
            'x-bbl-route': location.hash.replace(/^#/, '') || '/mbrs/marketing/list',
            'x-req-zone-id': 'Asia/Shanghai',
            'x-lt-language': 'CN',
            'LAN': 'CN',
          },
          body: JSON.stringify({
            activity_id: activityId,
            is_partake: 0,
            main_site: 'shein',
            pricing_currency_code: 'SAR',
            skc_query: {grade_tree_list: []},
          }),
        });
        const packet = await response.json();
        const list = packet?.info?.partake_goods_list || [];
        apiSnapshot = {
          httpStatus: response.status,
          code: packet?.code ?? null,
          msg: packet?.msg || '',
          total: Number(packet?.info?.total ?? list.length),
          rows: list.map((row, index) => ({
            idx: index + 1,
            skc: String(row?.skc || '').toLowerCase(),
            supplierNo: row?.supplier_no || '',
            currentPrice: Number(row?.current_cost || row?.current_cost_display?.value || row?.shop_price || row?.special_price || row?.current_shop_price || 0),
            raw: row,
          })),
        };
      } catch (error) {
        apiSnapshot = {error: String(error?.message || error)};
      }
      const ancestors = [];
      for (let el = tbody; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        ancestors.push({
          tag: el.tagName,
          className: String(el.className || '').slice(0, 260),
          overflowY: style.overflowY,
          clientHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          rowCount: el.querySelectorAll('tbody tr').length,
        });
      }
      return {
        href: location.href,
        visibleRows: [...document.querySelectorAll('tbody tr')].filter(visible).map(rowInfo).filter(x => x.skc),
        allRows: [...document.querySelectorAll('tbody tr')].map(rowInfo).filter(x => x.skc),
        checkboxHtml: [...document.querySelectorAll('input[type=checkbox]')].map(x => x.closest('.soui-checkbox-wrapper,.merchant-ui-checkbox')?.outerHTML || x.outerHTML),
        inputSamples: [...document.querySelectorAll('input')].slice(0, 30).map(input => ({
          type: input.type,
          value: input.value,
          placeholder: input.getAttribute('placeholder') || '',
          visible: visible(input),
          parentText: (input.parentElement?.parentElement?.innerText || input.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          ancestorHtml: input.parentElement?.parentElement?.parentElement?.outerHTML?.slice(0, 5000) || '',
          html: input.outerHTML.slice(0, 1000),
        })),
        skcFilterHtml: [...document.querySelectorAll('div,section,form')]
          .filter(el => visible(el) && (el.innerText || '').replace(/\s+/g, '').includes('商品SKC'))
          .map(el => ({el, area:el.getBoundingClientRect().width * el.getBoundingClientRect().height}))
          .sort((a,b) => a.area - b.area)[0]?.el?.outerHTML?.slice(0, 20000) || '',
        apiSnapshot,
        ancestors,
        bodyTail: (document.body?.innerText || '').slice(-900),
      };
    `);
    return {ok: false, mode: 'choose', reason: 'selection_debug_only', pageSize, diagnostic};
  }

  const result = await evalJs(cdp, sessionId, `
    const allowSkcs = Array.isArray(__arg?.allowSkcs) ? __arg.allowSkcs.map(x => String(x || '').trim().toLowerCase()).filter(Boolean) : null;
    const allowSet = allowSkcs ? new Set(allowSkcs) : null;
    const seenAllowed = new Set();
    if (allowSet?.size === 1 && __arg?.preselectedSingle?.selected) seenAllowed.add([...allowSet][0]);
    let fullAllowlistHeaderConfirmed = false;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const isDisabled = el => !el || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
      !!el.closest('.ant-pagination-disabled,.soui-pagination-disabled,.disabled') ||
      String(el.className || '').includes('soui-button-disabled');
    const fire = el => {
      if (!el) return false;
      const target = el.matches?.('input[type=checkbox]')
        ? (el.closest('.soui-checkbox-wrapper,.merchant-ui-checkbox') || el.parentElement || el)
        : el;
      target.scrollIntoView({block:'center', inline:'center'});
      target.click();
      return true;
    };
    const headerCheckbox = () => {
      const th = [...document.querySelectorAll('th')].filter(visible).find(x => x.querySelector('input[type=checkbox]'));
      return th?.querySelector('input[type=checkbox]');
    };
    const pageButtons = () => [...document.querySelectorAll('.soui-pagination-buttons button, button')]
      .filter(visible)
      .filter(b => /^\\d+$/.test((b.innerText || '').trim()));
    const activePage = () => {
      const b = pageButtons().find(x => String(x.className || '').includes('soui-button-primary'));
      return Number((b?.innerText || '1').trim()) || 1;
    };
    const maxPage = () => Math.max(1, ...pageButtons().map(b => Number((b.innerText || '').trim()) || 1));
    const gotoPage = async n => {
      const btn = pageButtons().find(b => Number((b.innerText || '').trim()) === n);
      if (!btn || isDisabled(btn)) return activePage() === n;
      fire(btn);
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        if (activePage() === n) return true;
      }
      return activePage() === n;
    };
    const parseSelected = () => {
      const t = [...document.querySelectorAll('*')].filter(visible).map(x => x.innerText || '').find(t => /已选商品\\d+个/.test(t)) || '';
      const checkedRows = [...document.querySelectorAll('tbody tr input[type=checkbox]')]
        .filter(x => visible(x.closest('tr')) && x.checked && !isDisabled(x)).length;
      const fromText = Number((t.match(/已选商品(\\d+)个/) || [])[1] || 0);
      const selectedCount = fromText || checkedRows;
      return {
        selectedText: (t.match(/已选商品\\d+个/) || [])[0] || (selectedCount ? ('已选商品' + selectedCount + '个') : ''),
        selectedCount,
      };
    };
    const parseTotal = () => {
      const totals = [...document.querySelectorAll('*')]
        .filter(visible)
        .map(x => x.innerText || '')
        .map(t => ({text: (t.match(/总计\\s*\\d+\\s*个/) || [])[0] || '', value: Number((t.match(/总计\\s*(\\d+)\\s*个/) || [])[1] || 0)}))
        .filter(x => x.text);
      const best = totals.sort((a,b) => b.value - a.value)[0] || {text: '', value: 0};
      return {
        totalText: best.text,
        totalGoods: best.value,
      };
    };
    const seenRowsBySkc = new Map();
    const rowSnapshot = tr => {
      const cells = [...(tr?.querySelectorAll('td') || [])].map(td => td.innerText || '');
      const rowText = tr?.innerText || cells.join('\\n');
      const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0] || 0);
      const skc = String((rowText.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '').trim().toLowerCase();
      const supplierNo = String((rowText.match(/供方货号:\\s*([^\\n\\t]+)/) || [])[1] || '').trim();
      const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
      const currentPrice = Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || (cells[3] || '').match(/([\\d.]+)/) || [])[1] || 0);
      return {idx, skc, supplierNo, currentPrice, rowText: rowText.slice(0, 260)};
    };
    const recordRow = tr => {
      const row = rowSnapshot(tr);
      if (row.skc && !seenRowsBySkc.has(row.skc)) seenRowsBySkc.set(row.skc, row);
      return row;
    };
    const skcOfRow = tr => recordRow(tr).skc;
    const visibleGoodsRows = () => [...document.querySelectorAll('tbody tr')]
      .filter(visible)
      .filter(tr => rowSnapshot(tr).skc);
    const recordVisibleGoodsRows = () => {
      const rows = visibleGoodsRows();
      for (const tr of rows) {
        const row = recordRow(tr);
        if (allowSet?.has(row.skc)) seenAllowed.add(row.skc);
      }
      return rows;
    };
    const waitForSelectedCount = async expected => {
      for (let i = 0; i < 30; i++) {
        const count = parseSelected().selectedCount;
        if (count === expected) return true;
        await sleep(200);
      }
      return parseSelected().selectedCount === expected;
    };
    const selectExactFullAllowlistViaHeader = async totalGoods => {
      if (!allowSet || !totalGoods || allowSet.size !== totalGoods) return {used: false, clicks: 0};
      const rows = recordVisibleGoodsRows();
      const visibleSkcs = new Set(rows.map(row => rowSnapshot(row).skc).filter(Boolean));
      const seenSkcs = new Set(seenRowsBySkc.keys());
      const exactKnownSet = (rows.length === totalGoods && visibleSkcs.size === allowSet.size &&
        [...visibleSkcs].every(skc => allowSet.has(skc))) ||
        (seenSkcs.size === allowSet.size && [...seenSkcs].every(skc => allowSet.has(skc))) ||
        (allowSet.size === totalGoods && seenSkcs.size > 0 && [...seenSkcs].every(skc => allowSet.has(skc)));
      if (!exactKnownSet) return {used: false, clicks: 0};
      if (parseSelected().selectedCount === totalGoods) {
        fullAllowlistHeaderConfirmed = true;
        return {used: true, clicks: 0};
      }
      const cb = headerCheckbox();
      if (!cb) return {used: false, clicks: 0};
      const beforeCount = parseSelected().selectedCount;
      fire(cb);
      let selectedAll = await waitForSelectedCount(totalGoods);
      let clicks = 1;
      if (!selectedAll && beforeCount > 0 && parseSelected().selectedCount === 0) {
        fire(cb);
        clicks++;
        selectedAll = await waitForSelectedCount(totalGoods);
      }
      if (selectedAll) fullAllowlistHeaderConfirmed = true;
      return {used: selectedAll, clicks};
    };
    const selectUncheckedVisibleRows = async () => {
      let clicks = 0;
      const rowChecks = [...document.querySelectorAll('tr input[type=checkbox]')]
        .filter(x => visible(x.closest('tr')) && !x.checked && !isDisabled(x));
      for (const rowCb of rowChecks) {
        recordRow(rowCb.closest('tr'));
        fire(rowCb);
        clicks++;
        await sleep(100);
      }
      return clicks;
    };
    const ensureCheckedState = async (rowCb, shouldSelect) => {
      let clicks = 0;
      for (let attempt = 0; attempt < 3 && rowCb.checked !== shouldSelect; attempt++) {
        fire(rowCb);
        clicks++;
        await sleep(180);
      }
      return clicks;
    };
    const alignVisibleRowsToAllowlist = async () => {
      let clicks = 0;
      let visibleRows = 0;
      let visibleAllowed = 0;
      for (const rowCb of [...document.querySelectorAll('tr input[type=checkbox]')].filter(x => visible(x.closest('tr')) && !isDisabled(x))) {
        const tr = rowCb.closest('tr');
        recordRow(tr);
        const skc = skcOfRow(tr);
        if (!skc) continue;
        visibleRows++;
        const shouldSelect = allowSet.has(skc);
        if (shouldSelect) {
          visibleAllowed++;
          seenAllowed.add(skc);
        }
        clicks += await ensureCheckedState(rowCb, shouldSelect);
      }
      return {clicks, visibleRows, visibleAllowed};
    };
    const tableScroller = () => [...document.querySelectorAll('div,main,section')]
      .filter(visible)
      .filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
      .filter(el => el.querySelectorAll('tbody tr').length >= 2 && el.scrollHeight > el.clientHeight + 40)
      .sort((a,b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    const sweepVirtualRows = async totalGoods => {
      const scroller = tableScroller();
      if (!scroller) return 0;
      let clicks = 0;
      const step = Math.max(60, Math.floor(scroller.clientHeight * 0.25));
      for (let top = 0, guard = 0; guard < 160; guard++, top += step) {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        scroller.scrollTop = Math.min(top, max);
        scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
        await sleep(450);
        recordVisibleGoodsRows();
        if (allowSet) {
          clicks += (await alignVisibleRowsToAllowlist()).clicks;
        } else {
          clicks += await selectUncheckedVisibleRows();
        }
        const selectedNow = parseSelected().selectedCount;
        if (allowSet && seenAllowed.size >= allowSet.size) break;
        if (!allowSet && totalGoods && selectedNow >= totalGoods) break;
        if (top >= max) break;
      }
      return clicks;
    };
    let allowlistBatchFilter = __arg?.prefilteredAllowlist?.matched
      ? {applied:true, source:'cdp_real_click', ...__arg.prefilteredAllowlist}
      : {applied:false, prefilter:__arg?.prefilteredAllowlist || null};
    if (allowSet?.size && !allowlistBatchFilter.matched) {
      const textarea = [...document.querySelectorAll('textarea')]
        .filter(visible)
        .find(el => String(el.getAttribute('placeholder') || '').includes('回车分割'));
      let searchScope = textarea?.parentElement || null;
      for (let depth = 0; searchScope && depth < 12; depth += 1, searchScope = searchScope.parentElement) {
        const hasSearch = [...searchScope.querySelectorAll('button')]
          .some(button => visible(button) && (button.innerText || button.textContent || '').trim() === '搜索' && !isDisabled(button));
        if (hasSearch && (searchScope.innerText || '').includes('商品SKC')) break;
      }
      const searchButton = [...(searchScope || document).querySelectorAll('button')]
        .filter(visible)
        .find(button => (button.innerText || button.textContent || '').trim() === '搜索' && !isDisabled(button));
      if (textarea && searchButton) {
        const value = [...allowSet].join('\\n') + '\\n';
        textarea.focus();
        textarea.select();
        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
        if (desc?.set) desc.set.call(textarea, value); else textarea.value = value;
        textarea.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:value}));
        textarea.dispatchEvent(new Event('change', {bubbles:true}));
        textarea.dispatchEvent(new FocusEvent('blur', {bubbles:true}));
        await sleep(500);
        const textareaValueBeforeSearch = textarea.value;
        fire(searchButton);
        let matched = false;
        let totalAfterFilter = parseTotal().totalGoods;
        let visibleSkcs = [];
        for (let attempt = 0; attempt < 60; attempt += 1) {
          await sleep(250);
          const rows = recordVisibleGoodsRows();
          visibleSkcs = rows.map(tr => rowSnapshot(tr).skc).filter(Boolean);
          totalAfterFilter = parseTotal().totalGoods;
          matched = totalAfterFilter === allowSet.size
            && visibleSkcs.length > 0
            && visibleSkcs.every(skc => allowSet.has(skc));
          if (matched) break;
        }
        allowlistBatchFilter = {
          applied:true,
          matched,
          requested:allowSet.size,
          totalAfterFilter,
          visibleSkcs,
          textareaValueBeforeSearch,
          textareaValueAfterSearch:textarea.value,
          searchButtonText:(searchButton.innerText || searchButton.textContent || '').trim(),
        };
      } else {
        allowlistBatchFilter = {applied:false, matched:false, reason:'batch_skc_textarea_or_search_not_found'};
      }
    }
    let singleSkcFilter = {applied:false};
    if (allowSet?.size === 1 && !allowlistBatchFilter.applied && !__arg?.preselectedSingle?.selected) {
      const wanted = [...allowSet][0];
      const textInputs = [...document.querySelectorAll('input')]
        .filter(visible)
        .filter(input => !['checkbox', 'radio', 'hidden'].includes(input.type));
      const labelledSkcInput = textInputs.find(input => {
        let parent = input.parentElement;
        for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) {
          const text = (parent.innerText || parent.textContent || '').replace(/\s+/g, '');
          if (text.includes('商品SKC') && text.length < 500) return true;
        }
        return false;
      });
      const skcInput = labelledSkcInput || textInputs.find(input =>
        input.id !== 'soc-fe-search-btn' &&
        !String(input.className || '').includes('soui-input-input') &&
        !input.getAttribute('placeholder')
      );
      const searchButton = [...document.querySelectorAll('button')]
        .filter(visible)
        .find(button => (button.innerText || button.textContent || '').trim() === '搜索' && !isDisabled(button));
      if (skcInput && searchButton) {
        const proto = Object.getPrototypeOf(skcInput);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.set) desc.set.call(skcInput, wanted); else skcInput.value = wanted;
        skcInput.dispatchEvent(new Event('input', {bubbles:true}));
        skcInput.dispatchEvent(new Event('change', {bubbles:true}));
        await sleep(700);
        const optionCandidates = [...document.querySelectorAll('[role=option],li,div')]
          .filter(visible)
          .map(el => ({el, text:(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(), area:el.getBoundingClientRect().width * el.getBoundingClientRect().height}))
          .filter(x => x.text.toLowerCase().includes(wanted))
          .sort((a,b) => a.area - b.area);
        const option = optionCandidates[0];
        if (option?.el) {
          fire(option.el);
          await sleep(450);
        }
        fire(searchButton);
        let matched = false;
        let totalAfterFilter = parseTotal().totalGoods;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await sleep(250);
          const rows = recordVisibleGoodsRows();
          const visibleSkcs = rows.map(tr => rowSnapshot(tr).skc).filter(Boolean);
          totalAfterFilter = parseTotal().totalGoods;
          matched = totalAfterFilter === 1 && visibleSkcs.length === 1 && visibleSkcs[0] === wanted;
          if (matched) break;
        }
        singleSkcFilter = {applied:true, wanted, optionClicked:!!option?.el, optionText:option?.text || '', matched, totalAfterFilter};
      } else {
        singleSkcFilter = {applied:false, wanted, reason:'skc_search_controls_not_found'};
      }
    }
    const selectSingletonVisibleRow = async wanted => {
      for (const tr of [...document.querySelectorAll('tbody tr')]) {
        const row = recordRow(tr);
        if (row.skc !== wanted) continue;
        const checkbox = tr.querySelector('input[type=checkbox]');
        const firstCell = tr.querySelector('td:first-child');
        const clickTarget = checkbox || firstCell?.querySelector('.index__checkboxCenter--t0W3ObGk') || firstCell;
        if (!clickTarget) return {found:true, clicked:false, reason:'missing_row_select_target'};
        if (checkbox?.checked || parseSelected().selectedCount === 1) {
          seenAllowed.add(wanted);
          return {found:true, clicked:false, selected:true};
        }
        fire(clickTarget);
        const selected = await waitForSelectedCount(1);
        if (selected) seenAllowed.add(wanted);
        return {found:true, clicked:true, selected};
      }
      return {found:false, clicked:false, selected:false};
    };
    const sweepSingletonIntoView = async wanted => {
      let direct = await selectSingletonVisibleRow(wanted);
      if (direct.selected) return direct;
      const roots = [document.scrollingElement, ...document.querySelectorAll('div,main,section')]
        .filter(Boolean)
        .filter((root, index, all) => all.indexOf(root) === index)
        .filter(root => root.scrollHeight > root.clientHeight + 20)
        .sort((a,b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      for (const root of roots) {
        const max = Math.max(0, root.scrollHeight - root.clientHeight);
        const step = Math.max(80, Math.floor(Math.max(300, root.clientHeight) * 0.3));
        for (let top = 0, guard = 0; guard < 180; guard += 1, top += step) {
          if (root === document.scrollingElement) window.scrollTo(0, Math.min(top, max));
          else {
            root.scrollTop = Math.min(top, max);
            root.dispatchEvent(new Event('scroll', {bubbles:true}));
          }
          await sleep(300);
          recordVisibleGoodsRows();
          direct = await selectSingletonVisibleRow(wanted);
          if (direct.selected) return {...direct, root: root.tagName, top: Math.min(top, max), max};
          if (top >= max) break;
        }
      }
      return direct;
    };
    if (allowSet?.size === 1 && !allowlistBatchFilter.applied && parseSelected().selectedCount !== 1) {
      const wanted = [...allowSet][0];
      const directSelection = await sweepSingletonIntoView(wanted);
      singleSkcFilter = {...singleSkcFilter, directSelection};
    }
    let pages = 0;
    let selectedClicks = 0;
    const totalPages = maxPage();
    const total = parseTotal();
    for (let page = 1; page <= totalPages; page++) {
      await gotoPage(page);
      await sleep(500);
      if (allowSet) {
        recordVisibleGoodsRows();
        const exactHeader = await selectExactFullAllowlistViaHeader(total.totalGoods);
        selectedClicks += exactHeader.clicks;
        if (!exactHeader.used) selectedClicks += (await alignVisibleRowsToAllowlist()).clicks;
      } else {
        const cb = headerCheckbox();
        if (cb && !cb.checked) {
          fire(cb);
          selectedClicks++;
          await sleep(600);
        }
        selectedClicks += await selectUncheckedVisibleRows();
      }
      if ((allowSet && seenAllowed.size < allowSet.size) || (!allowSet && total.totalGoods && parseSelected().selectedCount < total.totalGoods)) {
        selectedClicks += await sweepVirtualRows(total.totalGoods);
      }
      if (allowSet && parseSelected().selectedCount !== allowSet.size) {
        selectedClicks += (await selectExactFullAllowlistViaHeader(total.totalGoods)).clicks;
      }
      pages++;
    }
    if (allowSet) {
      for (let round = 0; round < 2; round++) {
        const selectedNow = parseSelected().selectedCount;
        if (seenAllowed.size >= allowSet.size && selectedNow === allowSet.size) break;
        seenAllowed.clear();
        for (let page = 1; page <= totalPages; page++) {
          await gotoPage(page);
          await sleep(500);
          selectedClicks += (await alignVisibleRowsToAllowlist()).clicks;
          selectedClicks += await sweepVirtualRows(total.totalGoods);
          selectedClicks += (await selectExactFullAllowlistViaHeader(total.totalGoods)).clicks;
        }
      }
    }
    const selected = parseSelected();
    const availableRows = [...seenRowsBySkc.values()].sort((a,b) => a.idx - b.idx);
    const outOfPlanRows = allowSet ? availableRows.filter(row => row.skc && !allowSet.has(row.skc)) : [];
    const missingAllowedSkcs = allowSet && !fullAllowlistHeaderConfirmed ? [...allowSet].filter(skc => !seenAllowed.has(skc)).sort() : [];
    const expectedSelectedCount = allowSet ? allowSet.size : total.totalGoods;
    const directSingletonSelected = allowSet?.size === 1
      && selected.selectedCount === 1
      && seenAllowed.has([...allowSet][0]);
    const exactBatchFilteredSelection = Boolean(
      allowlistBatchFilter?.matched
      && allowlistBatchFilter?.totalAfterFilter === expectedSelectedCount
      && selected.selectedCount === expectedSelectedCount
    );
    const selectedMatchesPlan = allowSet
      ? missingAllowedSkcs.length === 0
        && selected.selectedCount === expectedSelectedCount
        && (outOfPlanRows.length === 0 || directSingletonSelected || exactBatchFilteredSelection)
      : true;
    const debug = {
      trCount: document.querySelectorAll('tr').length,
      checkboxInputCount: document.querySelectorAll('input[type=checkbox]').length,
      customCheckboxCount: document.querySelectorAll('[role=checkbox],.soui-checkbox,.merchant-ui-checkbox,.ant-checkbox').length,
      tableCount: document.querySelectorAll('table').length,
      scrollCandidates: [...document.querySelectorAll('div,main,section')]
        .filter(visible)
        .filter(el => ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))
        .filter(el => el.querySelectorAll('tbody tr').length >= 2 && el.scrollHeight > el.clientHeight + 40)
        .map(el => ({tag: el.tagName, className: String(el.className || '').slice(0, 240), clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, rowCount: el.querySelectorAll('tbody tr').length})),
      rowTextSamples: [...document.querySelectorAll('tr')].slice(0, 5).map(tr => (tr.innerText || tr.textContent || '').trim().slice(0, 500)),
      rowHtmlSamples: [...document.querySelectorAll('tbody tr')].slice(0, 3).map(tr => tr.outerHTML.slice(0, 4000)),
      customCheckboxSamples: [...document.querySelectorAll('[role=checkbox],.soui-checkbox,.merchant-ui-checkbox,.ant-checkbox')].slice(0, 8).map(el => ({
        tag: el.tagName,
        className: String(el.className || '').slice(0, 300),
        role: el.getAttribute('role') || '',
        ariaChecked: el.getAttribute('aria-checked') || '',
        html: el.outerHTML.slice(0, 800),
      })),
      inputSamples: [...document.querySelectorAll('input')].slice(0, 20).map(input => ({
        type: input.type,
        value: input.value,
        placeholder: input.getAttribute('placeholder') || '',
        visible: visible(input),
        parentText: (input.parentElement?.parentElement?.innerText || input.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        html: input.outerHTML.slice(0, 1000),
      })),
      bodyHead: (document.body?.innerText || '').slice(0, 1500),
    };
    const nextStep = [...document.querySelectorAll('button')].filter(visible).find(b => b.innerText.trim() === '下一步');
    const canNext = nextStep && !nextStep.disabled && selectedMatchesPlan;
    if (canNext) fire(nextStep);
    return {
      pages,
      totalPages,
      selectedClicks,
      clickedNext: Boolean(canNext),
      selectionMode: allowSet ? 'allowlist' : 'all',
      selectionEvidenceMode: fullAllowlistHeaderConfirmed
        ? 'plan_count_visible_membership_header_count'
        : (exactBatchFilteredSelection ? 'exact_batch_filter_and_selected_count' : 'row_membership'),
      expectedSelectedCount,
      matchedAllowedCount: allowSet ? (fullAllowlistHeaderConfirmed ? allowSet.size : seenAllowed.size) : null,
      missingAllowedSkcs,
      selectedMatchesPlan,
      availableRows,
      outOfPlanRows,
      outOfPlanCount: outOfPlanRows.length,
      allowlistBatchFilter,
      singleSkcFilter,
      preselectedSingle: __arg?.preselectedSingle || null,
      debug,
      ...total,
      ...selected,
    };
  `, {allowSkcs, preselectedSingle, prefilteredAllowlist, activityInventoryTransactionPlan});

  const editReady = await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 30_000);
  const inventoryPlanOk = activityInventoryTransactionPlan.ok === true;
  const selectedOk = inventoryPlanOk && (result.selectionMode === 'allowlist'
    ? result.selectedMatchesPlan
    : (!result.totalGoods || result.selectedCount >= result.totalGoods));
  if (!editReady && selectedOk && result.selectionMode === 'allowlist' && result.clickedNext) {
    await evalJs(cdp, sessionId, `
      const visible = el => {
        if (!el) return false;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const nextStep = [...document.querySelectorAll('button')]
        .filter(visible)
        .find(b => (b.innerText || b.textContent || '').trim() === '下一步' && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (nextStep) {
        nextStep.scrollIntoView({block:'center', inline:'center'});
        nextStep.click();
      }
      return Boolean(nextStep);
    `).catch(() => false);
  }
  const editReadyAfterRetry = editReady || await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 10_000);
  const reason = selectedOk
    ? undefined
    : (!inventoryPlanOk
      ? `活动最低库存 live 证据不完整：${activityInventoryTransactionPlan.blockers.map(row => row.reason).join(',') || 'unknown'}`
      : (result.selectionMode === 'allowlist'
      ? `选择计划不匹配：已选 ${result.selectedCount}/${result.expectedSelectedCount}，未找到 ${result.missingAllowedSkcs?.join(',') || '-'}`
      : `只选中 ${result.selectedCount}/${result.totalGoods} 个商品`));
  return {
    ...result,
    pageSize,
    activityInventoryTransactionPlan,
    ok: editReadyAfterRetry && selectedOk,
    mode: editReadyAfterRetry ? 'edit' : 'choose',
    reason,
  };
}

async function queryOrdinaryActivityInventoryTransactionPlan(cdp, sessionId, allowSkcs) {
  return await evalJs(cdp, sessionId, `
    const allow = new Set((Array.isArray(__arg) ? __arg : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
    const activityId = Number((location.href.match(/\\/config\\/(\\d+)/) || [])[1] || 0);
    const source = 'ordinary_activity_query_supplier_goods_list_v2';
    const number = value => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const first = (row, fields) => {
      for (const field of fields) {
        const value = number(row?.[field]);
        if (value !== null) return {field, value};
      }
      return {field:'', value:null};
    };
    try {
      const response = await fetch('/mrs-api-prefix/mbrs/activity/query_supplier_goods_list_v2?page_num=1&page_size=500', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json;charset=UTF-8',
          'Origin-Url': location.href,
          'x-bbl-route': location.hash.replace(/^#/, '') || '/mbrs/marketing/list',
          'x-req-zone-id': 'Asia/Shanghai',
          'x-lt-language': 'CN',
          'LAN': 'CN',
        },
        body: JSON.stringify({
          activity_id: activityId,
          is_partake: 0,
          main_site: 'shein',
          pricing_currency_code: 'SAR',
          skc_query: {grade_tree_list: []},
        }),
      });
      const packet = await response.json();
      const list = packet?.info?.partake_goods_list || [];
      if (!response.ok || String(packet?.code ?? '0') !== '0') {
        return {
          ok:false,
          source,
          activityId,
          rows:[],
          blockers:[{reason:'ordinary_activity_goods_query_failed', httpStatus:response.status, code:packet?.code ?? null, message:packet?.msg || ''}],
          writeAttempted:false,
        };
      }
      const rows = list
        .map(row => {
          const skc = String(row?.skc || '').trim().toLowerCase();
          if (!skc || (allow.size && !allow.has(skc))) return null;
          const current = first(row, [
            'total_usable_inventory', 'totalUsableInventory', 'usable_inventory_num',
            'usableInventoryNum', 'inventory_num', 'inventoryNum', 'ivt_num', 'stock_num',
          ]);
          const minimum = first(row, [
            'activity_min_stock', 'activityMinStock', 'min_stock', 'minStock',
            'minimum_stock', 'minimumStock', 'minimum_inventory_num', 'minimumInventoryNum',
          ]);
          const minimumUsableInventory = minimum.value !== null && minimum.value > 0
            ? Math.ceil(minimum.value)
            : null;
          const currentUsableInventory = current.value !== null && current.value >= 0
            ? Math.floor(current.value)
            : null;
          return {
            skc,
            canonical: String(row?.supplier_no || row?.sku_supplier_no || '').trim(),
            currentUsableInventory,
            currentSourceField: current.field,
            minimumUsableInventory,
            minimumSourceField: minimum.field,
            minimumRequired: minimumUsableInventory !== null,
            requiresTemporaryRaise: minimumUsableInventory !== null
              && currentUsableInventory !== null
              && currentUsableInventory < minimumUsableInventory,
          };
        })
        .filter(Boolean);
      const found = new Set(rows.map(row => row.skc));
      const missing = [...allow].filter(skc => !found.has(skc));
      const blockers = missing.map(skc => ({skc, reason:'ordinary_activity_goods_query_missing_target'}));
      for (const row of rows) {
        if (row.minimumRequired && row.currentUsableInventory === null) {
          blockers.push({skc:row.skc, reason:'ordinary_activity_live_usable_inventory_missing'});
        }
      }
      return {
        ok:blockers.length === 0,
        source,
        activityId,
        queriedAt:new Date().toISOString(),
        total:Number(packet?.info?.total ?? list.length),
        rows,
        blockers,
        writeAttempted:false,
      };
    } catch (error) {
      return {
        ok:false,
        source,
        activityId,
        rows:[],
        blockers:[{reason:'ordinary_activity_goods_query_exception', error:String(error?.message || error)}],
        writeAttempted:false,
      };
    }
  `, allowSkcs || []);
}

function computeTarget(storeKey, activityId, row) {
  const supplier = row.supplierNo || '';
  const normalized = normalizeGoodsSnDetailed(supplier, {goodsTitle: row.goodsName || ''});
  const canonical = normalized.canonical || supplier;
  const keys = [
    compact(supplier),
    compact(canonical),
    compact(modelCode(supplier)),
    compact(modelCode(canonical)),
    compact(normalized.rawGoodsSn),
  ].filter(Boolean);
  const minDiscountFallbackNeedles = (args.minDiscountFallback || []).map(compact).filter(Boolean);
  const useMinDiscountFallback = minDiscountFallbackNeedles.some(needle => keys.some(k => k.includes(needle) || needle.includes(k)));
  const seed = `${storeKey}:${activityId}:${row.skc}:${supplier}`;
  const current = Number(row.currentPrice || 0);
  const minDiscount = Number(row.minDiscount || 10);
  const rowOverride = rowPriceOverrideRules.get(`${String(storeKey).trim().toUpperCase()}:${Number(activityId)}:${String(row.skc || '').trim().toLowerCase()}`);
  const manualRule = findManualRule(keys);
  const override = rowOverride
    || (manualRule
      ? null
      : (keys.map(k => storePriceOverrideRules.get(`${storeKey}:${k}`)).find(Boolean)
        || keys.map(k => priceOverrideRules.get(k)).find(Boolean)));
  if (override) {
    const targetBase = Number(override.targetPrice);
    const cost = override.cost === null || override.cost === undefined ? null : Number(override.cost);
    const marginFloor = override.minMarginFloor === null || override.minMarginFloor === undefined ? null : Number(override.minMarginFloor);
    if (!Number.isFinite(targetBase) || targetBase <= 0) {
      return {ok: false, reason: '覆盖价无效', supplierNo: supplier, canonical};
    }
    let target = round2(targetBase);
    let platformAdjusted = false;
    if (current > 0 && minDiscount > 0) {
      const maxPrice = floor2(current * (1 - minDiscount / 100));
      if (target > maxPrice) {
        target = maxPrice;
        platformAdjusted = true;
      }
    }
    const projectedMargin = cost && target > 0 ? (target - cost) / target : null;
    const floorBreached = marginFloor !== null && projectedMargin !== null && projectedMargin < marginFloor;
    const discountPct = discountPctForTarget(current, minDiscount, target);
    const platformAdjustmentAudit = buildOrdinaryPlatformPriceAdjustmentAudit({
      rule: override,
      adjustedTarget: target,
      platformAdjusted,
    });
    const couponStackRisk = platformAdjustedCouponRisk(override, target, platformAdjusted);
    return {
      ok: true,
      supplierNo: supplier,
      canonical,
      source: override.rule || 'price_override',
      ruleType: 'price_override',
      basePrice: targetBase,
      randomOffset: 0,
      marginTarget: null,
      marginUsed: projectedMargin === null ? null : round2(projectedMargin * 100),
      currentPrice: current,
      targetPrice: target,
      targetPriceText: target.toFixed(2),
      discountPct,
      minDiscount,
      platformAdjusted,
      minMarginFloor: marginFloor === null ? null : round2(marginFloor * 100),
      floorBreached,
      ...platformAdjustmentAudit,
      ...couponStackRisk,
    };
  }
  let source = '30pct_profit';
  let ruleType = 'margin';
  let base = null;
  let marginTarget = DEFAULT_MARGIN_TARGET;
  let marginUsed = null;
  let exposurePricing = null;
  if (manualRule) {
    base = manualRule.base;
    ruleType = manualRule.ruleType;
    source = manualRule.source;
    marginTarget = manualRule.marginTarget;
  }
  if (ruleType === 'margin' && marginTarget !== null) {
    exposurePricing = resolveExposureAdjustedMargin({
      baseMargin: marginTarget,
      storeKey,
      canonical,
      skc: row.skc,
      policy: PRICING_POLICY,
      exposureIndex: EXPOSURE_INDEX,
    });
    if (exposurePricing?.applied) {
      marginTarget = exposurePricing.margin;
      source = `${source}_${exposurePricing.isTopExposureLink ? 'exposure_top5' : 'exposure_other'}`;
    }
  }
  let cost = null;
  if (base === null) {
    const trueCostInfo = keys.map(k => TRUE_COSTS[k]).find(Boolean);
    const trueUnitCost = numValue(trueCostInfo?.trueUnitCostSar);
    const productUnitCost = numValue(trueCostInfo?.unitCostSar) ?? numValue(trueCostInfo?.productUnitCostSar);
    if (trueUnitCost !== null && trueUnitCost > 0) {
      cost = trueUnitCost;
    } else if (productUnitCost !== null && productUnitCost > 0) {
      cost = productUnitCost;
    }
    for (const k of keys) {
      if (cost !== null && Number.isFinite(cost)) break;
      if (COSTS[k] !== undefined) {
        cost = Number(COSTS[k]);
        break;
      }
    }
    if (cost === null || !Number.isFinite(cost)) {
      if (useMinDiscountFallback) {
        const current = Number(row.currentPrice || 0);
        const minDiscount = Number(row.minDiscount || 10);
        if (current > 0 && minDiscount > 0) {
          const target = floor2(current * (1 - minDiscount / 100));
          return {
            ok: true,
            supplierNo: supplier,
            canonical,
            source: 'min_discount_fallback',
            ruleType: 'min_discount_fallback',
            basePrice: current,
            randomOffset: 0,
            marginTarget: null,
            marginUsed: null,
            currentPrice: current,
            targetPrice: target,
            targetPriceText: target.toFixed(2),
            discountPct: minDiscount,
            minDiscount,
            platformAdjusted: true,
            fallbackReason: 'missing_cost_min_discount',
          };
        }
      }
      return {ok: false, reason: '缺成本', supplierNo: supplier, canonical};
    }
    const floorMargin = pctConfigToRatio(PRICING_POLICY?.targetFloorMarginPct ?? PRICING_POLICY?.exposureTopLinks?.floorMarginPct ?? 15);
    marginUsed = exposurePricing?.applied
      ? marginTarget
      : Math.min(0.95, Math.max(floorMargin || 0.01, marginTarget + randomBetween(seed, MARGIN_TARGET_JITTER.min, MARGIN_TARGET_JITTER.max)));
    base = cost / (1 - marginTarget);
  } else {
    base = Number(base);
  }
  const offset = ruleType === 'fixed_price'
    ? randomBetween(seed, FIXED_PRICE_JITTER.min, FIXED_PRICE_JITTER.max)
    : (marginUsed - marginTarget);
  let target = ruleType === 'fixed_price'
    ? round2(base + offset)
    : round2(cost / (1 - marginUsed));
  let platformAdjusted = false;
  if (current > 0 && minDiscount > 0) {
    const maxPrice = floor2(current * (1 - minDiscount / 100));
    if (target > maxPrice) {
      target = maxPrice;
      platformAdjusted = true;
    }
  }
  const discountPct = discountPctForTarget(current, minDiscount, target);
  return {
    ok: true,
    supplierNo: supplier,
    canonical,
    source,
    ruleType,
    basePrice: round2(base),
    randomOffset: round2(offset),
    marginTarget: marginTarget === null ? null : round2(marginTarget * 100),
    marginUsed: marginUsed === null ? null : round2(marginUsed * 100),
    currentPrice: current,
    targetPrice: target,
    targetPriceText: target.toFixed(2),
    discountPct,
    minDiscount,
    platformAdjusted,
    exposurePricing,
  };
}

async function collectVisibleRows(cdp, sessionId) {
  return await evalJs(cdp, sessionId, `
    const rows = [];
    let lastSkc = '';
    let lastSupplierNo = '';
    for (const tr of document.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
      if (cells.length < 6) continue;
      const rowText = tr.innerText || cells.join('\\n');
      const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
      const info = rowText;
      const inputs = [...tr.querySelectorAll('input')];
      const explicitSkc = (info.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '';
      const explicitSupplierNo = (info.match(/供方货号:\\s*([^\\n\\t]+)/) || [])[1]?.trim() || '';
      if (explicitSkc) lastSkc = explicitSkc;
      if (explicitSupplierNo) lastSupplierNo = explicitSupplierNo;
      const skc = explicitSkc || lastSkc || '';
      const supplierNo = explicitSupplierNo || lastSupplierNo || '';
      const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
      const currentPrice = Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || (cells[3] || '').match(/([\\d.]+)/) || [])[1] || 0);
      const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
      const radioInputs = inputs.filter(x => x.type === 'radio');
      const discountText = cells.join(' ');
      const discountMatches = [...discountText.matchAll(/(\\d+(?:\\.\\d+)?)%\\s*价格降幅/g)].map(m => Number(m[1]));
      let minDiscount = Number(((cells[5] || '').match(/降幅要求[:：]\\s*(\\d+(?:\\.\\d+)?)%/) || [])[1] || 0);
      if (!minDiscount && discountMatches.length) minDiscount = Math.max(...discountMatches);
      if (!minDiscount) minDiscount = 10;
      let editMode = 'price';
      if (radioInputs.length >= 2 && /VIP档|普通档/.test(discountText)) editMode = 'vip_discount';
      if (!idx || !skc || (textInputs.length < 1 && editMode !== 'vip_discount')) continue;
      rows.push({idx, key: skc.toLowerCase(), skc, supplierNo, currentPrice, minDiscount, editMode, goodsName: info.slice(0, 200)});
    }
    return rows;
  `);
}

async function fillVisibleRows(cdp, sessionId, fills) {
  return await evalJs(cdp, sessionId, `
    const fills = new Map(__arg.map(x => [String(x.key || x.skc || x.idx).toLowerCase(), x]));
    const bySkc = new Map(__arg.filter(x => x.skc).map(x => [String(x.skc).toLowerCase(), x]));
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const floor2 = n => Math.floor(Number(n || 0) * 100 + 1e-9) / 100;
    const currentPriceFromRow = (cells, rowText) => {
      const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
      return Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || (cells[3] || '').match(/([\\d.]+)/) || (rowText || '').match(/SAR\\s*([\\d.]+)/i) || [])[1] || 0);
    };
    const setNativeValue = (el, value) => {
      const v = String(value);
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
      el.dispatchEvent(new FocusEvent('blur', {bubbles:true}));
    };
    const clickInput = el => {
      if (!el) return;
      el.click();
      el.dispatchEvent(new Event('input', {bubbles:true}));
      el.dispatchEvent(new Event('change', {bubbles:true}));
    };
    const done = [];
    let lastSkc = '';
    for (const tr of document.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
      const rowText = tr.innerText || cells.join('\\n');
      const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
      const explicitSkc = (rowText.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '';
      if (explicitSkc) lastSkc = explicitSkc;
      const skc = explicitSkc || lastSkc || '';
      const key = String(skc || idx).toLowerCase();
      if (!fills.has(key) && !bySkc.has(key)) continue;

      const inputs = [...tr.querySelectorAll('input')];
      const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
      const radioInputs = inputs.filter(x => x.type === 'radio');
      const discountText = cells.join(' ');
      const vipMode = radioInputs.length >= 2 && /VIP档|普通档/.test(discountText);
      if (textInputs.length < 1 && !vipMode) continue;
      const baseFill = fills.get(key) || bySkc.get(key);
      const f = {...baseFill};
      const rowCurrentPrice = currentPriceFromRow(cells, rowText);
      if (rowCurrentPrice > 0 && f.targetPrice > 0) {
        f.currentPrice = rowCurrentPrice;
        f.discountPct = Math.max(Number(f.minDiscount || 10), Math.floor((1 - Number(f.targetPrice) / rowCurrentPrice) * 100 + 1e-9));
        f.targetPriceText = floor2(rowCurrentPrice * (1 - f.discountPct / 100)).toFixed(2);
      }
      if (f.editMode === 'vip_discount' || vipMode) {
        clickInput(radioInputs[1] || radioInputs[0]);
        await sleep(180);
        const freshTextInputs = [...tr.querySelectorAll('input')].filter(x => /^(text|number)$/.test(x.type || 'text'));
        if (!freshTextInputs.length) continue;
        const discountInput = freshTextInputs.find(x => !String(x.className || '').includes('ant-input-number-input')) || freshTextInputs[0];
        setNativeValue(discountInput, String(f.discountPct));
        await sleep(160);
        const priceInput = freshTextInputs.find(x => String(x.className || '').includes('ant-input-number-input')) || freshTextInputs[1];
        done.push({
          idx,
          key,
          skc,
          price: f.targetPriceText,
          discount: String(f.discountPct),
          actualPrice: priceInput?.value || '',
          actualDiscount: String(parseInt(discountInput?.value || '', 10)),
          editMode: f.editMode,
          inheritedSkc: !explicitSkc,
        });
      } else {
        const pairs = [];
        for (let i = 0; i < textInputs.length; i += 2) {
          const priceInput = textInputs[i];
          const discountInput = textInputs[i + 1] || inputs[i + 1];
          if (priceInput && discountInput) pairs.push({priceInput, discountInput});
        }
        if (!pairs.length) pairs.push({priceInput: textInputs[0], discountInput: textInputs[1] || inputs[1]});
        for (const pair of pairs) {
          setNativeValue(pair.discountInput, String(f.discountPct));
          await sleep(30);
          setNativeValue(pair.priceInput, f.targetPriceText);
          await sleep(120);
          if (f.ruleType === 'fixed_price') {
            setNativeValue(pair.priceInput, f.targetPriceText);
            await sleep(60);
          }
        }
        done.push({
          idx,
          key,
          skc,
          price: f.targetPriceText,
          discount: String(f.discountPct),
          actualPrice: pairs[0]?.priceInput?.value || '',
          actualDiscount: String(parseInt(pairs[0]?.discountInput?.value || '', 10)),
          editMode: f.editMode || 'price',
          filledInputPairs: pairs.length,
          inheritedSkc: !explicitSkc,
        });
      }
    }
    return done;
  `, fills);
}

async function getScrollInfo(cdp, sessionId) {
  return await evalJs(cdp, sessionId, `
    const candidates = [...document.querySelectorAll('div,main,section')]
      .filter(el => el.querySelectorAll('tr input').length >= 2)
      .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
    const el = candidates.find(x => x.scrollHeight > x.clientHeight + 50);
    if (!el) return {hasScroller:false, max:0, candidates:candidates.slice(0,5).map(x => ({tag:x.tagName, cls:String(x.className || '').slice(0,80), scrollHeight:x.scrollHeight, clientHeight:x.clientHeight, inputs:x.querySelectorAll('tr input').length}))};
    return {hasScroller:true, max: Math.max(0, el.scrollHeight - el.clientHeight), tag:el.tagName, cls:String(el.className || '').slice(0,120), inputs:el.querySelectorAll('tr input').length};
  `);
}

async function scrollTo(cdp, sessionId, top) {
  return await evalJs(cdp, sessionId, `
    const candidates = [...document.querySelectorAll('div,main,section')]
      .filter(el => el.querySelectorAll('tr input').length >= 2 && el.scrollHeight > el.clientHeight + 50)
      .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
    const el = candidates[0];
    if (el) {
      el.scrollTop = __arg;
      el.dispatchEvent(new Event('scroll', {bubbles:true}));
    } else {
      window.scrollTo(0, __arg);
    }
    return true;
  `, top);
}

async function fillEditPage(cdp, sessionId, storeKey, activityId, allowSkcs = null) {
  const ready = await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 30_000);
  if (!ready) return {ok: false, reason: '编辑页未加载'};
  const rowEditorReady = await waitFor(cdp, sessionId, `
    [...document.querySelectorAll('tr')].some(tr => {
      const cells = tr.querySelectorAll('td');
      const textInputs = [...tr.querySelectorAll('input')].filter(x => /^(text|number)$/.test(x.type || 'text'));
      return cells.length >= 6 && textInputs.length >= 1;
    })
  `, 60_000);
  if (!rowEditorReady) return {ok: false, reason: '编辑表格未加载'};
  await sleep(1500);

  const expectedTotal = await evalJs(cdp, sessionId, `
    const m = (document.body.innerText || '').match(/总计\\s*(\\d+)\\s*个/);
    return m ? Number(m[1]) : 0;
  `).catch(() => 0);

  const targets = new Map();
  const missingCost = new Map();
  const priceStackBlockers = new Map();
  const filled = new Map();
  const seenRows = new Map();
  const allowSet = allowSkcs ? new Set(allowSkcs.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)) : null;
  const allowedUneditableSet = new Set(args.allowUneditableSkcs.filter(skc => !allowSet || allowSet.has(skc)));
  const outOfPlanRows = new Map();
  const requiredCoverage = Math.max(0, (allowSet?.size || expectedTotal) - allowedUneditableSet.size);
  let top = 0;
  let fillSweeps = 0;
  // Virtualized rows can consistently fall between two fixed scroll landing
  // points. Retry with staggered, progressively smaller steps so later sweeps
  // cover the gaps left by the first pass.
  const sweepSteps = [450, 325, 240, 175, 120];
  for (let sweep = 1; sweep <= sweepSteps.length; sweep += 1) {
    fillSweeps = sweep;
    const scrollStep = sweepSteps[sweep - 1];
    top = sweep === 1 ? 0 : Math.floor(scrollStep / 2);
    for (let guard = 0; guard < 240; guard++) {
      const scroll = await getScrollInfo(cdp, sessionId);
      const max = scroll.hasScroller ? scroll.max : 0;
      await scrollTo(cdp, sessionId, top);
      await sleep(sweep === 1 ? 250 : 450);
      const rows = await collectVisibleRows(cdp, sessionId);
      const fills = [];
      for (const row of rows) {
        seenRows.set(row.key, row);
        if (allowSet && !allowSet.has(String(row.skc || '').trim().toLowerCase())) {
          outOfPlanRows.set(row.key, row);
          continue;
        }
        const computed = computeTarget(storeKey, activityId, row);
        if (!computed.ok) {
          if (computed.priceStackBlocker) {
            priceStackBlockers.set(row.key, {...row, ...computed});
          } else {
            missingCost.set(row.key, {...row, ...computed});
          }
          continue;
        }
        const full = {...row, ...computed};
        targets.set(row.key, full);
        fills.push(full);
      }
      const done = await fillVisibleRows(cdp, sessionId, fills);
      for (const d of done) filled.set(d.key || d.idx, d);
      const covered = new Set([...targets.keys(), ...missingCost.keys(), ...priceStackBlockers.keys()]).size;
      if (requiredCoverage && covered >= requiredCoverage) break;
      if (!scroll.hasScroller || top >= max) break;
      top = Math.min(top + scrollStep, max);
    }
    const covered = new Set([...targets.keys(), ...missingCost.keys(), ...priceStackBlockers.keys()]).size;
    if (!requiredCoverage || covered >= requiredCoverage) break;
    await sleep(600);
  }

  // 二次复核
  const verifyRows = new Map();
  const verifySteps = [450, 325, 240, 175, 120];
  for (let sweep = 1; sweep <= verifySteps.length; sweep += 1) {
    const scrollStep = verifySteps[sweep - 1];
    top = sweep === 1 ? 0 : Math.floor(scrollStep / 2);
    for (let guard = 0; guard < 240; guard++) {
      const scroll = await getScrollInfo(cdp, sessionId);
      const max = scroll.hasScroller ? scroll.max : 0;
      await scrollTo(cdp, sessionId, top);
      await sleep(sweep === 1 ? 200 : 350);
      const rows = await evalJs(cdp, sessionId, `
      const rows = [];
      let lastSkc = '';
      for (const tr of document.querySelectorAll('tr')) {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText || '');
        const rowText = tr.innerText || cells.join('\\n');
        const idx = Number(((cells[0] || rowText).match(/\\d+/) || [])[0]);
        const explicitSkc = (rowText.match(/SKC:\\s*([a-z]{2}\\d+)/i) || [])[1] || '';
        if (explicitSkc) lastSkc = explicitSkc;
        const skc = explicitSkc || lastSkc || '';
        const key = String(skc || idx).toLowerCase();
        const sku = (rowText.match(/SKU:\\s*([a-z0-9]+)/i) || [])[1] || '';
        const priceCell = cells.find(c => /SAR\\s*[\\d.]+/i.test(c)) || '';
        const currentPrice = Number((priceCell.match(/SAR\\s*([\\d.]+)/i) || [])[1] || 0);
        const inputs = [...tr.querySelectorAll('input')];
        const textInputs = inputs.filter(x => /^(text|number)$/.test(x.type || 'text'));
        const radioInputs = inputs.filter(x => x.type === 'radio');
        if (!idx || textInputs.length < 1) continue;
        const discountText = cells.join(' ');
        const editMode = radioInputs.length >= 2 && /VIP档|普通档/.test(discountText) ? 'vip_discount' : 'price';
        if (editMode === 'vip_discount') {
          const discountInput = textInputs.find(x => !String(x.className || '').includes('ant-input-number-input')) || textInputs[0];
          const priceInput = textInputs.find(x => String(x.className || '').includes('ant-input-number-input')) || textInputs[1];
          rows.push({idx, key, skc, sku, currentPrice, price: priceInput?.value || '', discount: String(parseInt(discountInput?.value || '', 10)), editMode});
        } else rows.push({idx, key, skc, sku, currentPrice, price: textInputs[0].value, discount: String(parseInt((textInputs[1] || inputs[1]).value, 10)), editMode});
      }
      return rows;
      `);
      for (const r of rows) {
        const key = r.key || r.idx;
        const variants = verifyRows.get(key) || [];
        const variantKey = `${r.idx}:${r.sku || ''}`;
        const at = variants.findIndex(x => `${x.idx}:${x.sku || ''}` === variantKey);
        if (at >= 0) variants[at] = r; else variants.push(r);
        verifyRows.set(key, variants);
      }
      const allTargetsVerified = targets.size > 0 && [...targets.keys()].every(key => verifyRows.has(key));
      if (allTargetsVerified) break;
      if (!scroll.hasScroller || top >= max) break;
      top = Math.min(top + scrollStep, max);
    }
    const allTargetsVerified = targets.size > 0 && [...targets.keys()].every(key => verifyRows.has(key));
    if (allTargetsVerified) break;
    await sleep(500);
  }
  const mismatches = [];
  const platformRewrites = [];
  for (const [key, t] of targets.entries()) {
    const candidates = verifyRows.get(key) || [];
    const r = candidates[0];
    const fillEvidence = filled.get(key);
    const expectedByDiscount = floor2(t.currentPrice * (1 - t.discountPct / 100)).toFixed(2);
    if (t.editMode === 'vip_discount') {
      const targetPriceNum = Number(t.targetPriceText);
      const checks = candidates.map(variant => {
        const currentPrice = Number(variant.currentPrice || 0);
        const expectedDiscount = currentPrice > 0
          ? Math.max(Number(t.minDiscount || 10), Math.floor((1 - targetPriceNum / currentPrice) * 100 + 1e-9))
          : Number(t.discountPct);
        const expectedPrice = currentPrice > 0 ? floor2(currentPrice * (1 - expectedDiscount / 100)) : Number(expectedByDiscount);
        const actualPrice = Number(variant.price);
        const discountOk = variant.discount === String(expectedDiscount);
        const priceOk = !variant.price || (Number.isFinite(actualPrice) && Math.abs(actualPrice - expectedPrice) <= 0.55);
        return {variant, expectedDiscount, expectedPrice, ok: discountOk && priceOk};
      });
      const failed = checks.find(check => !check.ok);
      const fillDiscountOk = fillEvidence?.actualDiscount === String(t.discountPct);
      const fillPrice = Number(fillEvidence?.actualPrice);
      const fillPriceOk = !fillEvidence?.actualPrice || (Number.isFinite(fillPrice) && Math.abs(fillPrice - Number(expectedByDiscount)) <= 0.55);
      if ((!candidates.length && !(fillDiscountOk && fillPriceOk)) || failed) {
        mismatches.push({idx: failed?.variant?.idx ?? t.idx, key, expectedPrice: failed?.expectedPrice ?? t.targetPriceText, actualPrice: failed?.variant?.price, expectedDiscount: String(failed?.expectedDiscount ?? t.discountPct), actualDiscount: failed?.variant?.discount, supplierNo: t.supplierNo, skc: t.skc, sku: failed?.variant?.sku || '', editMode: t.editMode, variantCount: candidates.length});
      }
      continue;
    }
    const variantPriceChecks = candidates.map(variant => {
      const actual = Number(variant.price);
      const variantCurrentPrice = Number(variant.currentPrice || t.currentPrice || 0);
      const expectedVariantDiscount = variantCurrentPrice > 0
        ? Math.max(Number(t.minDiscount || 10), Math.floor((1 - Number(t.targetPriceText) / variantCurrentPrice) * 100 + 1e-9))
        : Number(t.discountPct);
      const variantExpectedByDiscount = floor2(variantCurrentPrice * (1 - expectedVariantDiscount / 100));
      const discountOk = variant.discount === String(expectedVariantDiscount);
      const exactTarget = discountOk && variant.price === t.targetPriceText;
      const platformRewrite = isOrdinaryPlatformTierRewriteAccepted({
        actualPrice: actual,
        platformExpectedPrice: variantExpectedByDiscount,
        discountMatches: discountOk,
      });
      return {variant, actual, expectedVariantDiscount, variantExpectedByDiscount, exactTarget, platformRewrite, ok: exactTarget || platformRewrite};
    });
    const acceptableVariantPrices = variantPriceChecks.length && variantPriceChecks.every(check => check.ok);
    if (acceptableVariantPrices && variantPriceChecks.some(check => check.platformRewrite && !check.exactTarget)) {
      platformRewrites.push({
        idx: t.idx,
        key,
        expectedPrice: t.targetPriceText,
        actualPrice: r.price,
        discount: String(t.discountPct),
        supplierNo: t.supplierNo,
        skc: t.skc,
        direction: Number(r.price) < Number(t.targetPriceText) ? 'below_approved_target' : 'at_or_above_approved_target',
        policy: 'submit_platform_minimum_tier_and_audit',
      });
      continue;
    }
    if (acceptableVariantPrices) continue;
    if (!candidates.length && fillEvidence) {
      const actualPrice = String(fillEvidence.actualPrice || '');
      const actualDiscount = String(fillEvidence.actualDiscount || '');
      if (actualPrice === expectedByDiscount && actualDiscount === String(t.discountPct) && actualPrice !== t.targetPriceText) {
        platformRewrites.push({
          idx: t.idx,
          key,
          expectedPrice: t.targetPriceText,
          actualPrice,
          discount: String(t.discountPct),
          supplierNo: t.supplierNo,
          skc: t.skc,
          source: 'immediate_fill_readback',
          direction: Number(actualPrice) < Number(t.targetPriceText) ? 'below_approved_target' : 'at_or_above_approved_target',
          policy: 'submit_platform_minimum_tier_and_audit',
        });
        continue;
      }
      if (actualPrice === t.targetPriceText && actualDiscount === String(t.discountPct)) continue;
    }
    if (!candidates.length || candidates.some(variant => variant.price !== t.targetPriceText || variant.discount !== String(t.discountPct))) {
      mismatches.push({
        idx: t.idx,
        key,
        expectedPrice: t.targetPriceText,
        actualPrice: r?.price,
        expectedDiscount: String(t.discountPct),
        actualDiscount: r?.discount,
        supplierNo: t.supplierNo,
        skc: t.skc,
        variantPriceChecks: variantPriceChecks.map(check => ({
          currentPrice: check.variant.currentPrice,
          actualPrice: check.variant.price,
          actualDiscount: check.variant.discount,
          expectedVariantDiscount: check.expectedVariantDiscount,
          variantExpectedByDiscount: check.variantExpectedByDiscount,
          exactTarget: check.exactTarget,
          platformRewrite: check.platformRewrite,
        })),
      });
    }
  }
  const coverageCount = new Set([...targets.keys(), ...missingCost.keys(), ...priceStackBlockers.keys()]).size;
  const explicitlyAllowedUneditableSkcs = [...allowedUneditableSet].filter(skc => (
    !targets.has(skc) && !missingCost.has(skc) && !priceStackBlockers.has(skc)
  ));
  const expectedPlanTotal = (allowSet ? allowSet.size : expectedTotal) - explicitlyAllowedUneditableSkcs.length;
  const coverageOk = !expectedPlanTotal || coverageCount >= expectedPlanTotal;
  return {
    ok: missingCost.size === 0 && priceStackBlockers.size === 0 && mismatches.length === 0 && coverageOk && outOfPlanRows.size === 0,
    expectedTotal,
    expectedPlanTotal,
    coverageCount,
    explicitlyAllowedUneditableSkcs,
    fillSweeps,
    targetCount: targets.size,
    filledCount: filled.size,
    verifyCount: [...verifyRows.values()].reduce((sum, rows) => sum + rows.length, 0),
    missingCost: [...missingCost.values()].sort((a,b) => a.idx - b.idx),
    priceStackBlockers: [...priceStackBlockers.values()].sort((a,b) => a.idx - b.idx),
    outOfPlanRows: [...outOfPlanRows.values()].sort((a,b) => a.idx - b.idx),
    mismatches,
    platformRewrites,
    platformAdjusted: [...targets.values()].filter(x => x.platformAdjusted),
    targets: [...targets.values()].sort((a,b) => a.idx - b.idx),
  };
}

async function submitSignup(cdp, sessionId) {
  const clicked = await evalJs(cdp, sessionId, `
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const buttons = [...document.querySelectorAll('button,[role=button],.so-button,.soui-button,.ant-btn')]
      .filter(visible);
    const submit = buttons.find(b => (b.innerText || b.textContent || '').trim() === '提交报名' && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
    if (!submit) return {ok:false, reason:'未找到可点击的提交报名按钮'};
    submit.scrollIntoView({block:'center', inline:'center'});
    submit.click();
    return {ok:true, clickedText:(submit.innerText || submit.textContent || '').trim()};
  `);
  if (!clicked?.ok) return clicked || {ok: false, reason: '提交按钮点击失败'};
  await sleep(800);

  const confirmed = {clicked:false, attempts: []};
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const confirmAttempt = await evalJs(cdp, sessionId, `
    const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const normalize = s => String(s || '').replace(/\\s+/g, '').trim();
    const ackNeedle = '我已确认本次报名含有商品降幅超过50%的商品';
    const bodyText = document.body?.innerText || '';
    let ack = {needed:false, clicked:false};
    if (bodyText.includes(ackNeedle)) {
      const ackCandidates = [...document.querySelectorAll('label,[role=checkbox],input[type=checkbox],.so-checkbox,.soui-checkbox,.ant-checkbox-wrapper,.ant-checkbox')]
        .filter(el => visible(el) || el.tagName === 'INPUT')
        .map(el => ({el, text: normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || ''), type: el.tagName, checked: el.checked || el.getAttribute('aria-checked') === 'true'}));
      const byText = ackCandidates.find(x => x.text.includes(normalize(ackNeedle)) && !x.checked);
      const checkbox = byText || ackCandidates.find(x => x.type === 'INPUT' && !x.checked) || ackCandidates.find(x => !x.checked);
      if (checkbox?.el) {
        const target = checkbox.el.closest('label') || checkbox.el;
        target.scrollIntoView({block:'center', inline:'center'});
        target.click();
        ack = {needed:true, clicked:true, via:'checkbox', text:checkbox.text, type:checkbox.type};
      } else {
        const labels = [...document.querySelectorAll('label,span,div')]
          .filter(visible)
          .map(el => ({el, text: normalize(el.innerText || el.textContent || ''), area: el.getBoundingClientRect().width * el.getBoundingClientRect().height}))
          .filter(x => x.text.includes(normalize(ackNeedle)))
          .sort((a,b) => a.area - b.area);
        if (labels[0]?.el) {
          labels[0].el.scrollIntoView({block:'center', inline:'center'});
          labels[0].el.click();
          ack = {needed:true, clicked:true, via:'label', text:labels[0].text.slice(0, 80)};
        } else {
          ack = {needed:true, clicked:false, reason:'未找到低于5折确认勾选控件'};
        }
      }
      await new Promise(r => setTimeout(r, 350));
    }
    const buttons = [...document.querySelectorAll('button,[role=button],.so-button,.soui-button,.ant-btn')]
      .filter(visible)
      .map(b => ({el:b, text:(b.innerText || b.textContent || '').trim(), norm:normalize(b.innerText || b.textContent || ''), disabled:!!b.disabled || b.getAttribute('aria-disabled') === 'true'}))
      .filter(x => x.text && !x.disabled);
    const confirm = buttons.find(x => /^(确认报名|确认|确定|提交)$/.test(x.text) || /确认.*报名/.test(x.norm));
    if (!confirm) return {clicked:false, ack};
    confirm.el.scrollIntoView({block:'center', inline:'center'});
    confirm.el.click();
    return {clicked:true, clickedText:confirm.text, ack};
    `).catch(err => ({clicked:false, error:String(err?.message || err)}));
    confirmed.attempts.push(confirmAttempt);
    if (confirmAttempt?.clicked) {
      confirmed.clicked = true;
      confirmed.clickedText = confirmAttempt.clickedText;
      confirmed.ack = confirmAttempt.ack;
      await sleep(700);
      continue;
    }
    const interim = await evalJs(cdp, sessionId, `
      const text = document.body?.innerText || '';
      return {
        url: location.href,
        success: /\\/success(?:\\b|$)/.test(location.href) || /(提交成功|报名成功|活动报名成功)/.test(text),
        error: /(失败|错误|异常|不能为空|请填写|请先|未填写|error)/i.test(text),
        pendingConfirm: text.includes('确认报名') || text.includes('降幅已超过50%') || text.includes('低于5折'),
      };
    `).catch(() => ({}));
    if (interim?.success || interim?.error) break;
    await sleep(interim?.pendingConfirm ? 700 : 500);
  }
  await sleep(3000);

  const state = await evalJs(cdp, sessionId, `
    const text = document.body?.innerText || '';
    const url = location.href;
    const errorMatch = text.match(/(失败|错误|异常|不能为空|请填写|请先|未填写|error)/i);
    const successMatch = text.match(/(提交成功|报名成功|成功)/);
    const successUrl = /\\/success(?:\\b|$)/.test(url);
    const pendingConfirm = text.includes('确认报名') || text.includes('降幅已超过50%') || text.includes('低于5折');
    return {
      url,
      successUrl,
      successText: successMatch ? successMatch[1] : '',
      errorText: errorMatch ? errorMatch[1] : '',
      pendingConfirm,
      tail: text.slice(-500),
    };
  `).catch(err => ({errorText:String(err?.message || err)}));
  const success = Boolean(state?.successUrl || state?.successText);
  const errorText = state?.errorText || '';
  const reason = errorText
    ? `提交后页面出现异常提示：${errorText}`
    : success
      ? undefined
      : state?.pendingConfirm
        ? '提交后仍停留在二次确认弹窗，未到成功页'
        : `提交后未确认成功页：${state?.url || ''}`;
  return {
    ok: !errorText && success,
    submitted: success,
    clicked,
    confirmed,
    state,
    reason,
  };
}

async function processActivity(cdp, store, activity) {
  const allowSkcs = selectionAllowList(store.storeKey, activity.activityId);
  if (args.selectionPlan && (!allowSkcs || !allowSkcs.length)) {
    return {
      ok: true,
      skipped: true,
      store: store.storeKey,
      activity,
      reason: 'selection-plan 中没有该店铺活动 allowlist，跳过以避免误全选',
    };
  }
  const url = `${LIST_URL.replace('/list', `/sign-up/config/${activity.activityId}`)}`;
  const {targetId, sessionId} = await newPage(cdp, url);
  let firstState = await waitForActivityOrLogin(cdp, sessionId, 35_000);
  const renderRecovery = {needed: Boolean(firstState.renderError), ok: !firstState.renderError, attempts: []};
  for (let attempt = 1; firstState.renderError && attempt <= 3; attempt += 1) {
    await cdp.call('Page.reload', {ignoreCache: attempt > 1}, sessionId).catch(() => {});
    await sleep(2500 * attempt);
    firstState = await waitForActivityOrLogin(cdp, sessionId, 35_000);
    renderRecovery.attempts.push({attempt, state: firstState});
    if (firstState.activityReady || firstState.loginReady) {
      renderRecovery.ok = true;
      break;
    }
  }
  const loginRecovery = firstState.loginReady ? await recoverLoginIfNeeded(cdp, sessionId) : {needed: false, ok: true, before: firstState, attempts: []};
  if (loginRecovery.needed && !loginRecovery.ok) {
    return {ok: false, store: store.storeKey, activity, targetId, loginRecovery, reason: '活动页登录恢复失败'};
  }
  let loadedState = loginRecovery.needed ? await waitForActivityOrLogin(cdp, sessionId, 35_000) : firstState;
  const forceRefreshRecovery = {needed: !loadedState.activityReady, ok: Boolean(loadedState.activityReady), attempts: []};
  for (let attempt = 1; !loadedState.activityReady && attempt <= 3; attempt += 1) {
    await cdp.call('Page.reload', {ignoreCache: true}, sessionId).catch(() => (
      evalJs(cdp, sessionId, `location.reload(); return {href: location.href};`).catch(() => null)
    ));
    await sleep(2500 * attempt);
    loadedState = await waitForActivityOrLogin(cdp, sessionId, 35_000);
    if (loadedState.loginReady) {
      const refreshLoginRecovery = await recoverLoginIfNeeded(cdp, sessionId);
      if (refreshLoginRecovery.needed && refreshLoginRecovery.ok) {
        loadedState = await waitForActivityOrLogin(cdp, sessionId, 35_000);
      }
      forceRefreshRecovery.attempts.push({attempt, state: loadedState, loginRecovery: refreshLoginRecovery});
    } else {
      forceRefreshRecovery.attempts.push({attempt, state: loadedState});
    }
    if (loadedState.activityReady) {
      forceRefreshRecovery.ok = true;
      break;
    }
  }
  const loaded = Boolean(loadedState.activityReady);
  if (!loaded) {
    const pageState = await evalJs(cdp, sessionId, `
      const text = document.body?.innerText || '';
      return {href: location.href, title: document.title || '', head: text.slice(0, 800), tail: text.slice(-800)};
    `).catch(err => ({error: err.message}));
    return {ok: false, store: store.storeKey, activity, targetId, firstState, renderRecovery, loginRecovery, forceRefreshRecovery, loadedState, pageState, reason: '活动页面未加载'};
  }

  const selection = await selectAllGoodsAndNext(cdp, sessionId, allowSkcs);
  if (!selection.ok) return {ok: false, store: store.storeKey, activity, targetId, selection, reason: selection.reason || '选择商品失败'};

  if (args.fillDebugSkc) {
    const ready = await waitFor(cdp, sessionId, `document.body && document.body.innerText.includes('提报的活动价格')`, 30_000);
    const rowEditorReady = ready && await waitFor(cdp, sessionId, `
      [...document.querySelectorAll('tbody tr')].some(tr => {
        const cells = tr.querySelectorAll('td');
        const inputs = [...tr.querySelectorAll('input')];
        return cells.length >= 6 && inputs.some(x => /^(text|number|radio)$/.test(x.type || 'text'));
      })
    `, 60_000);
    const diagnostic = rowEditorReady ? await evalJs(cdp, sessionId, `
      const target = __arg;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const inspect = (top = 0, max = 0) => {
        for (const tr of document.querySelectorAll('tr')) {
          const rowText = tr.innerText || '';
          if (!rowText.toLowerCase().includes(target)) continue;
          return {
            target,
            found: true,
            top,
            max,
            text: rowText.slice(0, 2400),
            html: tr.outerHTML.slice(0, 12000),
            inputs: [...tr.querySelectorAll('input')].map(x => ({type:x.type, value:x.value, checked:x.checked, disabled:x.disabled, className:String(x.className || '')})),
            buttons: [...tr.querySelectorAll('button')].map(x => ({text:(x.innerText || x.textContent || '').trim(), disabled:x.disabled})),
            cells: [...tr.querySelectorAll('td')].map(td => (td.innerText || '').slice(0, 800)),
          };
        }
        return null;
      };
      const immediate = inspect();
      if (immediate) return {...immediate, via:'immediate_dom'};
      const candidates = [...document.querySelectorAll('div,main,section')]
        .filter(el => el.querySelectorAll('tr').length >= 2 && el.scrollHeight > el.clientHeight + 40)
        .sort((a,b) => (b.scrollHeight-b.clientHeight) - (a.scrollHeight-a.clientHeight));
      const scroller = candidates[0];
      if (!scroller) return {target, found:false, reason:'no_table_scroller', rows:document.querySelectorAll('tr').length, bodyHas:(document.body?.innerText || '').toLowerCase().includes(target)};
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      for (let top = 0, guard = 0; guard < 500; guard += 1, top += 80) {
        scroller.scrollTop = Math.min(top, max);
        scroller.dispatchEvent(new Event('scroll', {bubbles:true}));
        await sleep(120);
        const hit = inspect(top, max);
        if (hit) return {...hit, via:'table_scroller'};
        if (top >= max) break;
      }
      return {target, found:false, max};
    `, args.fillDebugSkc) : {target: args.fillDebugSkc, found:false, reason: ready ? 'edit_rows_not_ready' : 'edit_page_not_ready'};
    return {ok: false, store: store.storeKey, activity, targetId, selection, fillDebugOnly: true, diagnostic, reason: 'fill_debug_only'};
  }

  const fill = await fillEditPage(cdp, sessionId, store.storeKey, activity.activityId, allowSkcs);
  if (!fill.ok) {
    const currentUrl = await evalJs(cdp, sessionId, `return location.href;`).catch(() => '');
    return {ok: false, store: store.storeKey, activity, targetId, selection, fill, url: currentUrl, reason: '填价复核失败，未提交'};
  }
  const submit = args.submit ? await submitSignup(cdp, sessionId) : {ok: true, submitted: false, skipped: true, reason: '未传 --submit，按预填模式停留'};
  const currentUrl = await evalJs(cdp, sessionId, `return location.href;`).catch(() => '');
  return {ok: fill.ok && submit.ok, store: store.storeKey, activity, targetId, selection, fill, submit, url: currentUrl, reason: submit.ok ? undefined : submit.reason};
}

let selectedStores = STORES.filter(s => s.enabled)
  .filter(s => {
    if (args.stores.length) return args.stores.includes(s.storeKey);
    if (s.groupKey !== 'DSY') return false;
    return s.storeKey !== 'MZ';
  });

if (args.runtimePort !== null) {
  if (selectedStores.length !== 1) throw new Error('--runtime-port 只允许与单店 --stores 一起使用');
  if (!Number.isInteger(args.runtimePort) || args.runtimePort < 1024 || args.runtimePort > 65535) {
    throw new Error(`Invalid --runtime-port: ${args.runtimePort}`);
  }
  selectedStores = selectedStores.map(store => ({...store, port: args.runtimePort}));
}

const summary = {
  createdAt: new Date().toISOString(),
  now: now.toISOString(),
  hours: args.hours,
  allOpen: args.allOpen,
  includeCoupon: args.includeCoupon,
  submit: args.submit,
  selectionPlan: args.selectionPlan || '',
  executionWorkFingerprint: args.executionWorkFingerprint || '',
  approvalManifest: EXECUTION_APPROVAL ? path.relative(ROOT, EXECUTION_APPROVAL.manifestPath) : '',
  approvalManifestHash: EXECUTION_APPROVAL?.manifestHash || '',
  lowEtFastSellerPricePullback: LOW_ET_PRICE_PULLBACK,
  stores: [],
};

for (const store of selectedStores) {
  console.log(`\n[${store.storeKey}] 打开${args.headless ? '云端无头' : '可见前端'}浏览器并检查活动...`);
  let cdp = null;
  try {
    if (!args.noClose) {
      closeExistingStoreChrome(store);
      await sleep(2500);
      launchVisible(store);
      await sleep(3500);
    }
    bringStoreWindowToFront(store);
    await sleep(800);
    cdp = await connectStore(store);
    const listPage = await newPage(cdp, LIST_URL);
    await waitFor(cdp, listPage.sessionId, 'document.body', 30_000);
    const loginRecovery = await recoverLoginIfNeeded(cdp, listPage.sessionId);
    if (loginRecovery.needed && !loginRecovery.ok) {
      throw new Error(`登录恢复失败：${JSON.stringify(loginRecovery.attempts?.slice(-1)?.[0] || loginRecovery.after || loginRecovery.before)}`);
    }
    const identity = await assertCurrentStoreIdentity(cdp, listPage.sessionId, store, 'dsy_marketing_deadline_fill');
    const activities = await fetchActivities(cdp, listPage.sessionId);
    await cdp.call('Target.closeTarget', {targetId: listPage.targetId}).catch(() => {});
    const due = dueActivities(activities);
    const plannedActivities = [];
    const skippedActivities = [];
    for (const activity of due) {
      const allowSkcs = selectionAllowList(store.storeKey, activity.activityId);
      if (args.selectionPlan && (!allowSkcs || !allowSkcs.length)) {
        skippedActivities.push({
          activityId: activity.activityId,
          name: activity.name,
          reason: 'selection-plan 中没有该店铺活动 allowlist，跳过以避免误全选',
        });
      } else {
        plannedActivities.push(activity);
      }
    }
    const storeResult = {store: store.storeKey, shopName: store.shopName, port: store.port, identity, loginRecovery, dueActivities: due, plannedActivities, skippedActivities, results: []};
    summary.stores.push(storeResult);
    const scopeLabel = args.allOpen ? '所有未截止可报名活动' : (args.activityIds.length ? '指定活动' : `${args.hours}小时内截止活动`);
    console.log(`[${store.storeKey}] ${scopeLabel}：${due.map(a => `${a.activityId}-${a.name}`).join('；') || '无'}`);
    if (skippedActivities.length) {
      console.log(`[${store.storeKey}] 跳过无 allowlist 活动：${skippedActivities.map(a => `${a.activityId}-${a.name}`).join('；')}`);
    }
    const keepTargetIds = [];
    for (const activity of plannedActivities) {
      console.log(`[${store.storeKey}] 处理 ${activity.activityId} ${activity.name}`);
      const result = await processActivity(cdp, store, activity).catch(err => ({ok: false, store: store.storeKey, activity, reason: err.message, stack: err.stack}));
      result.executionWorkFingerprint = args.executionWorkFingerprint || '';
      result.lowEtFastSellerPricePullback = {
        evidenceHash: LOW_ET_PRICE_PULLBACK.evidenceHash,
        rows: LOW_ET_PRICE_PULLBACK.results.filter(row => (
          String(row.storeKey || '').toUpperCase() === String(store.storeKey || '').toUpperCase()
          && selectionAllowList(store.storeKey, activity.activityId)?.includes(String(row.skc || '').toLowerCase())
        )),
      };
      storeResult.results.push(result);
      if (result.targetId && (result.ok || args.noClose)) keepTargetIds.push(result.targetId);
      const file = path.join(OUT_DIR, `${store.storeKey}-${activity.activityId}.json`);
      await fs.writeFile(file, JSON.stringify(result, null, 2), 'utf8');
      console.log(`[${store.storeKey}] ${activity.activityId} ${result.ok ? '完成' : '异常'} ${result.reason || ''}`);
    }
    await cleanupStorePages(cdp, keepTargetIds);
  } catch (err) {
    summary.stores.push({store: store.storeKey, shopName: store.shopName, port: store.port, error: err.message, stack: err.stack});
    console.log(`[${store.storeKey}] 异常：${err.message}`);
  } finally {
    if (!args.noClose && cdp && process.platform !== 'win32') {
      await cdp.call('Browser.close').catch(() => {});
      await sleep(500);
    }
    cdp?.close();
    if (!args.noClose) {
      await sleep(500);
      closeExistingStoreChrome(store);
    }
  }
}

const summaryFile = path.join(OUT_DIR, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2), 'utf8');
console.log(`\nSUMMARY ${summaryFile}`);
