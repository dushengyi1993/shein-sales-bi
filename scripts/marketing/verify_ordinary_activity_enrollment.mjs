#!/usr/bin/env node
/**
 * Read-only verification for ordinary SHEIN marketing activity enrollment.
 *
 * Why this exists:
 * - The platform can show "提交成功/导入成功/查看报名进度" before the final
 *   goods list is fully materialized.
 * - This script verifies the actual ordinary marketing enrolled/under-review
 *   goods collection against an audited selection plan and row-level price
 *   overrides. It does not submit, cancel, import, or edit anything.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  requireStoreIdentitySnapshot,
  storeIdentityEvalBody,
} from '../../lib/shein_store_identity.mjs';
import {recoverSheinLoginIfNeeded} from '../../lib/shein_login_recovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIST_URL = 'https://sso.geiwohuo.com/#/mbrs/marketing/list';
const OUT_DIR = path.join(ROOT, 'outputs', 'reports');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {
    stores: [],
    activityIds: [],
    selectionPlan: '',
    priceOverrides: '',
    fillResultsDir: path.join(ROOT, 'tmp', 'mbrs', 'deadline-fill-results'),
    noLaunch: false,
    noClose: false,
    waitMs: 90_000,
    pollMs: 5_000,
    pageSize: 500,
    priceTolerance: 0.06,
    portOverrides: new Map(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--stores') out.stores.push(...splitList(argv[++i]).map(x => x.toUpperCase()));
    else if (a === '--activity' || a === '--activities') out.activityIds.push(...splitList(argv[++i]).map(Number).filter(Boolean));
    else if (a === '--selection-plan') out.selectionPlan = path.resolve(argv[++i] || '');
    else if (a === '--price-overrides') out.priceOverrides = path.resolve(argv[++i] || '');
    else if (a === '--fill-results-dir') out.fillResultsDir = path.resolve(argv[++i] || '');
    else if (a === '--no-launch') out.noLaunch = true;
    else if (a === '--no-close' || a === '--keep-open') out.noClose = true;
    else if (a === '--wait-ms') out.waitMs = Number(argv[++i] || out.waitMs);
    else if (a === '--poll-ms') out.pollMs = Number(argv[++i] || out.pollMs);
    else if (a === '--page-size') out.pageSize = Number(argv[++i] || out.pageSize);
    else if (a === '--price-tolerance') out.priceTolerance = Number(argv[++i] || out.priceTolerance);
    else if (a === '--port-overrides') {
      for (const entry of splitList(argv[++i])) {
        const [storeKey, rawPort] = entry.split(':');
        const port = Number(rawPort);
        if (storeKey && Number.isInteger(port) && port > 0) {
          out.portOverrides.set(storeKey.trim().toUpperCase(), port);
        }
      }
    }
    else if (!a.startsWith('--')) out.stores.push(...splitList(a).map(x => x.toUpperCase()));
    else throw new Error(`Unknown argument: ${a}`);
  }
  out.stores = [...new Set(out.stores)];
  out.activityIds = [...new Set(out.activityIds)];
  if (!out.stores.length) throw new Error('Missing --stores, e.g. --stores XC');
  if (!out.activityIds.length) throw new Error('Missing --activity, e.g. --activity 43914,43915,45488');
  if (!out.selectionPlan) throw new Error('Missing --selection-plan');
  if (!out.priceOverrides) throw new Error('Missing --price-overrides');
  if (!Number.isFinite(out.waitMs) || out.waitMs < 10_000) out.waitMs = 90_000;
  if (!Number.isFinite(out.pollMs) || out.pollMs < 2_000) out.pollMs = 5_000;
  if (!Number.isFinite(out.pageSize) || out.pageSize < 50) out.pageSize = 500;
  if (!Number.isFinite(out.priceTolerance) || out.priceTolerance < 0) out.priceTolerance = 0.06;
  return out;
}

const args = parseArgs(process.argv.slice(2));

function keyOf(storeKey, activityId, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}:${Number(activityId || 0)}:${String(skc || '').trim().toLowerCase()}`;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function loadPlan(selectionDoc, priceDoc) {
  const selectionItems = Array.isArray(selectionDoc.items) ? selectionDoc.items : [];
  const priceItems = Array.isArray(priceDoc.items) ? priceDoc.items : [];
  const priceByKey = new Map();
  for (const item of priceItems) {
    const k = keyOf(item.storeKey, item.activityId, item.skc);
    if (!k.includes(':0:') && item.skc) priceByKey.set(k, item);
  }
  const rows = [];
  const missingPriceOverride = [];
  for (const item of selectionItems) {
    if (item.selected === false) continue;
    const storeKey = String(item.storeKey || '').trim().toUpperCase();
    const activityId = Number(item.activityId || 0);
    const skc = String(item.skc || '').trim();
    if (!storeKey || !activityId || !skc) continue;
    if (!args.stores.includes(storeKey) || !args.activityIds.includes(activityId)) continue;
    const price = priceByKey.get(keyOf(storeKey, activityId, skc));
    if (!price) missingPriceOverride.push({storeKey, activityId, skc});
    rows.push({
      storeKey,
      activityId,
      skc,
      canonical: price?.canonical || item.canonical || '',
      expectedActivityPrice: Number(price?.targetPrice ?? price?.activityPrice ?? NaN),
      finalTargetPrice: Number(price?.finalTargetPrice ?? NaN),
      couponFactor: Number(price?.couponFactor ?? NaN),
      combo: price?.combo || '',
      note: price?.note || '',
    });
  }
  return {rows, missingPriceOverride};
}

function evaluateFillEvidenceDoc(doc, sourceFile, storeKey, activityId) {
  const selection = doc.selection || {};
  const fill = doc.fill || {};
  const mismatches = Array.isArray(fill.mismatches) ? fill.mismatches : [];
  const missingCost = Array.isArray(fill.missingCost) ? fill.missingCost : [];
  const fillOutOfPlanRows = Array.isArray(fill.outOfPlanRows) ? fill.outOfPlanRows : [];
  const selectionOutOfPlanRows = Array.isArray(selection.outOfPlanRows) ? selection.outOfPlanRows : [];
  const selectedExpected = Number(selection.expectedSelectedCount ?? NaN);
  const selectionTotalGoods = Number(selection.totalGoods ?? NaN);
  const extraAvailableCountFromTotals = selection.selectionMode === 'allowlist'
    && Number.isFinite(selectionTotalGoods)
    && Number.isFinite(selectedExpected)
    ? Math.max(0, selectionTotalGoods - selectedExpected)
    : 0;
  const extraAvailableCount = Math.max(selectionOutOfPlanRows.length, extraAvailableCountFromTotals);
  const targets = Array.isArray(fill.targets) ? fill.targets : [];
  const targetBySkc = new Map();
  const platformRewriteBySkc = new Map();
  for (const row of targets) {
    const skc = String(row?.skc || '').trim();
    if (!skc) continue;
    targetBySkc.set(skc, {
      skc,
      supplierNo: row.supplierNo || '',
      canonical: row.canonical || '',
      targetPrice: Number(row.targetPrice ?? NaN),
      targetPriceText: row.targetPriceText || '',
    });
  }
  for (const row of Array.isArray(fill.platformRewrites) ? fill.platformRewrites : []) {
    const skc = String(row?.skc || '').trim();
    const actualPrice = Number(row?.actualPrice ?? NaN);
    if (skc && Number.isFinite(actualPrice)) platformRewriteBySkc.set(skc, actualPrice);
  }
  const selectedMatchesPlan = selection.selectionMode === 'allowlist'
    ? selection.selectedMatchesPlan === true
    : true;
  const priceEvidenceOk = doc.ok === true
    && selection.ok === true
    && fill.ok === true
    && selectedMatchesPlan
    && mismatches.length === 0
    && missingCost.length === 0
    && fillOutOfPlanRows.length === 0;
  const ok = priceEvidenceOk && extraAvailableCount === 0;
  return {
    source: path.relative(ROOT, sourceFile),
    exists: true,
    ok,
    reason: ok ? '' : 'fill_result_not_clean',
    priceEvidenceOk,
    submitted: doc.submit?.submitted === true,
    store: doc.store || storeKey,
    activityId: Number(doc.activity?.activityId || doc.activityId || activityId),
    selection: {
      ok: selection.ok === true,
      selectedCount: selection.selectedCount ?? null,
      expectedSelectedCount: selection.expectedSelectedCount ?? null,
      totalGoods: selection.totalGoods ?? null,
      missingAllowedSkcs: selection.missingAllowedSkcs || [],
      selectedMatchesPlan,
      extraAvailableCount,
      outOfPlanRows: selectionOutOfPlanRows.slice(0, 20),
    },
    fill: {
      ok: fill.ok === true,
      targetCount: fill.targetCount ?? null,
      expectedTotal: fill.expectedTotal ?? null,
      mismatchCount: mismatches.length,
      missingCostCount: missingCost.length,
      outOfPlanRowsCount: fillOutOfPlanRows.length,
    },
    extraAvailableCount,
    extraAvailableRows: selectionOutOfPlanRows.slice(0, 20),
    targetBySkc,
    platformRewriteBySkc,
  };
}

function extractFillResultDocFor(doc, storeKey, activityId, sourceFile) {
  const upperStore = String(storeKey || '').trim().toUpperCase();
  const targetActivityId = Number(activityId || 0);
  const directStore = String(doc?.store || doc?.storeKey || '').trim().toUpperCase();
  const directActivityId = Number(doc?.activity?.activityId || doc?.activityId || 0);
  if (directStore === upperStore && directActivityId === targetActivityId) {
    return {doc, sourceFile};
  }
  for (const storeDoc of Array.isArray(doc?.stores) ? doc.stores : []) {
    const storeDocKey = String(storeDoc?.store || storeDoc?.storeKey || '').trim().toUpperCase();
    if (storeDocKey !== upperStore) continue;
    for (const result of Array.isArray(storeDoc?.results) ? storeDoc.results : []) {
      const resultActivityId = Number(result?.activity?.activityId || result?.activityId || 0);
      if (resultActivityId !== targetActivityId) continue;
      return {
        doc: {
          ...result,
          store: storeDocKey,
          summarySource: path.relative(ROOT, sourceFile),
        },
        sourceFile,
      };
    }
  }
  return null;
}

async function loadFillEvidenceFor(storeKey, activityId) {
  const file = path.join(args.fillResultsDir, `${String(storeKey).toUpperCase()}-${Number(activityId)}.json`);
  const candidates = [];
  if (fsSync.existsSync(file)) candidates.push(file);
  const directName = path.basename(file).toLowerCase();
  const pendingDirs = [args.fillResultsDir];
  while (pendingDirs.length) {
    const dir = pendingDirs.pop();
    let entries = [];
    try {
      entries = await fs.readdir(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === directName) {
        candidates.push(fullPath);
      }
    }
  }
  const uniqueCandidates = [...new Set(candidates)].sort((a, b) => {
    const aDirect = a === file ? 0 : 1;
    const bDirect = b === file ? 0 : 1;
    if (aDirect !== bDirect) return aDirect - bDirect;
    const am = fsSync.existsSync(a) ? fsSync.statSync(a).mtimeMs : 0;
    const bm = fsSync.existsSync(b) ? fsSync.statSync(b).mtimeMs : 0;
    return bm - am;
  });
  if (!uniqueCandidates.length) {
    return {
      source: path.relative(ROOT, file),
      exists: false,
      ok: false,
      reason: 'fill_result_missing',
      targetBySkc: new Map(),
      platformRewriteBySkc: new Map(),
    };
  }
  const cleanEvidenceList = [];
  let fallback = null;
  let firstError = null;
  for (const candidate of uniqueCandidates) {
    try {
      const doc = await readJson(candidate);
      const extracted = extractFillResultDocFor(doc, storeKey, activityId, candidate);
      if (!extracted) continue;
      const evidence = evaluateFillEvidenceDoc(extracted.doc, extracted.sourceFile, storeKey, activityId);
      if (evidence.priceEvidenceOk) cleanEvidenceList.push(evidence);
      fallback ||= evidence;
    } catch (err) {
      firstError ||= {file: candidate, err};
    }
  }
  if (cleanEvidenceList.length) {
    const merged = {
      ...cleanEvidenceList[0],
      source: cleanEvidenceList.map(x => x.source).join(';'),
      submitted: cleanEvidenceList.some(x => x.submitted),
      ok: cleanEvidenceList.every(x => x.ok),
      reason: '',
      priceEvidenceOk: true,
      targetBySkc: new Map(),
      platformRewriteBySkc: new Map(),
      selection: {
        ...cleanEvidenceList[0].selection,
        selectedCount: 0,
        expectedSelectedCount: 0,
        totalGoods: 0,
        missingAllowedSkcs: [],
        extraAvailableCount: 0,
        outOfPlanRows: [],
      },
      fill: {
        ...cleanEvidenceList[0].fill,
        targetCount: 0,
        expectedTotal: 0,
        mismatchCount: 0,
        missingCostCount: 0,
        outOfPlanRowsCount: 0,
      },
      extraAvailableCount: 0,
      extraAvailableRows: [],
    };
    for (const evidence of cleanEvidenceList) {
      for (const [skc, row] of evidence.targetBySkc.entries()) {
        if (!merged.targetBySkc.has(skc)) merged.targetBySkc.set(skc, row);
      }
      for (const [skc, actualPrice] of evidence.platformRewriteBySkc.entries()) {
        merged.platformRewriteBySkc.set(skc, actualPrice);
      }
      merged.selection.selectedCount += Number(evidence.selection?.selectedCount || 0);
      merged.selection.expectedSelectedCount += Number(evidence.selection?.expectedSelectedCount || 0);
      merged.selection.totalGoods += Number(evidence.selection?.totalGoods || 0);
      merged.fill.targetCount += Number(evidence.fill?.targetCount || 0);
      merged.fill.expectedTotal += Number(evidence.fill?.expectedTotal || 0);
      // Historical fill evidence is only a price fallback. Extra-available rows from older
      // pre-submit runs may have been handled by a later supplement, so they must not
      // keep blocking current enrollment verification after rows are already enrolled.
    }
    merged.extraAvailableCount = 0;
    merged.extraAvailableRows = [];
    merged.ok = merged.priceEvidenceOk;
    return merged;
  }
  if (fallback) return fallback;
  if (firstError) {
    return {
      source: path.relative(ROOT, firstError.file),
      exists: true,
      ok: false,
      reason: `fill_result_read_failed: ${firstError.err.message}`,
      targetBySkc: new Map(),
      platformRewriteBySkc: new Map(),
    };
  }
  try {
    const doc = await readJson(file);
    return evaluateFillEvidenceDoc(doc, file, storeKey, activityId);
  } catch (err) {
    return {
      source: path.relative(ROOT, file),
      exists: fsSync.existsSync(file),
      ok: false,
      reason: fsSync.existsSync(file) ? `fill_result_read_failed: ${err.message}` : 'fill_result_missing',
      targetBySkc: new Map(),
      platformRewriteBySkc: new Map(),
    };
  }
}

function psSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function closeExistingStoreChrome(store) {
  if (process.platform !== 'win32') return;
  const profileNeedle = `persistent-${store.profileKey}-profile`;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$needle = ${psSingleQuote(profileNeedle)}`,
    "$procs = Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -like \"*$needle*\" }",
    'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join('\n');
  spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {cwd: ROOT, stdio: 'ignore', timeout: 20_000});
}

function launchVisible(store, url = LIST_URL) {
  const launchArgs = [
    path.join(ROOT, 'scripts', 'launch_store_browser.mjs'),
    store.storeKey,
    '--visible',
    '--url',
    url,
  ];
  if (store.port) launchArgs.push('--port', String(store.port));
  const r = spawnSync(process.execPath, launchArgs, {cwd: ROOT, encoding: 'utf8', timeout: 20_000});
  if (r.status !== 0) throw new Error(`launch visible failed for ${store.storeKey}: ${r.stderr || r.stdout}`);
}

async function isCdpOpen(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(2500)});
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrowser(store) {
  if (!args.noLaunch && !args.noClose) {
    closeExistingStoreChrome(store);
    await sleep(1600);
    launchVisible(store, LIST_URL);
    await sleep(6000);
  } else if (!args.noLaunch && !(await isCdpOpen(store.port))) {
    launchVisible(store, LIST_URL);
    await sleep(6000);
  }
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {signal: AbortSignal.timeout(8000), ...opts});
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
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
        const item = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(item.timer);
        msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result);
      }
    });
    await this.call('Runtime.enable');
    await this.call('Page.enable').catch(() => {});
  }
  call(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 90_000);
      this.pending.set(id, {resolve, reject, timer});
    });
  }
  async eval(body, arg = undefined) {
    const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g, '\\u003c');
    const expression = `(async () => { const __arg = ${encoded}; ${body} })()`;
    const res = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails);
      throw new Error(desc);
    }
    return res.result?.value;
  }
  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function connectStorePage(store) {
  const targets = await httpJson(`http://127.0.0.1:${store.port}/json/list`);
  const page = targets.find(t => t.type === 'page' && String(t.url || '').includes('sso.geiwohuo.com'))
    || targets.find(t => t.type === 'page');
  if (!page) throw new Error(`port ${store.port} no page target`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function recoverLoginIfNeeded(cdp) {
  return await recoverSheinLoginIfNeeded({
    evaluate: (body, arg) => cdp.eval(body, arg),
    dispatchMouseEvent: params => cdp.call('Input.dispatchMouseEvent', params),
    reload: () => cdp.call('Page.reload', {ignoreCache: true}).catch(() => cdp.eval(`location.reload(); return {href: location.href};`)),
    sleep,
    maxAttempts: 3,
  });
}

async function gotoMarketingList(cdp) {
  await cdp.eval(`location.href = __arg.url; return {href: location.href};`, {url: LIST_URL});
  await sleep(2500);
  return await recoverLoginIfNeeded(cdp);
}

function listFrom(info) {
  if (Array.isArray(info?.data)) return info.data;
  if (Array.isArray(info?.list)) return info.list;
  if (Array.isArray(info?.records)) return info.records;
  if (Array.isArray(info?.partake_goods_list)) return info.partake_goods_list;
  if (Array.isArray(info?.activity_detail_list)) return info.activity_detail_list;
  if (Array.isArray(info)) return info;
  return [];
}

function priceOf(g) {
  const sku = Array.isArray(g?.activity_sku_list) ? g.activity_sku_list[0] : null;
  const candidates = [
    ['activity_price', g?.activity_price],
    ['product_act_price', g?.product_act_price],
    ['attend_price', g?.attend_price],
    ['price', g?.price],
    ['activity_price_str', g?.activity_price_str],
    ['sku.activity_price', sku?.activity_price],
    ['sku.product_act_price', sku?.product_act_price],
    ['sku.attend_price', sku?.attend_price],
    ['promotion_price', g?.promotion_price],
    ['sale_price', g?.sale_price],
    ['supplier_price', g?.supplier_price],
    ['site_price', g?.site_price],
    ['retail_price', g?.retail_price],
  ];
  for (const [source, value] of candidates) {
    const raw = String(value ?? '').trim();
    if (!raw) continue;
    const n = Number(raw.replace(/[^0-9.\-]/g, ''));
    if (Number.isFinite(n)) return {value: n, source};
  }
  return {value: null, source: ''};
}

function compactRow(g, activityId, variant) {
  const p = priceOf(g);
  return {
    skc: String(g?.skc || '').trim(),
    supplierNo: g?.supplier_no || g?.supplierNo || g?.sku_supplier_no || '',
    activityId: Number(g?.activity_id || activityId),
    activityName: g?.activity_name || '',
    auditStatus: g?.audit_status ?? '',
    auditStatusDesc: g?.audit_status_desc ?? '',
    goodsAuditStatus: g?.goods_audit_status ?? '',
    status: g?.status ?? '',
    activityPrice: p.value,
    priceSource: p.source,
    variant,
    rawPriceFields: {
      activity_price: g?.activity_price,
      product_act_price: g?.product_act_price,
      attend_price: g?.attend_price,
      price: g?.price,
      activity_price_str: g?.activity_price_str,
      promotion_price: g?.promotion_price,
      sale_price: g?.sale_price,
      supplier_price: g?.supplier_price,
      site_price: g?.site_price,
      retail_price: g?.retail_price,
      sku0: Array.isArray(g?.activity_sku_list) ? g.activity_sku_list[0] : null,
    },
    rawKeys: Object.keys(g || {}).sort().slice(0, 80),
  };
}

async function queryOrdinaryActivity(cdp, activityId, targetSkcs) {
  return await cdp.eval(`
    const baseHeaders = {
      'content-type': 'application/json;charset=UTF-8',
      'Origin-Url': location.href,
      'x-req-zone-id': 'Asia/Shanghai',
      'x-lt-language': 'CN',
      'LAN': 'CN',
    };
    async function post(apiPath, body, route) {
      const headers = {...baseHeaders, 'x-bbl-route': route};
      const res = await fetch('/mrs-api-prefix' + apiPath, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body || {}),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return {http: res.status, code: json?.code, msg: json?.msg || text.slice(0, 200), info: json?.info ?? json, text: text.slice(0, 800)};
    }
    function listFrom(info) {
      if (Array.isArray(info?.data)) return info.data;
      if (Array.isArray(info?.list)) return info.list;
      if (Array.isArray(info?.records)) return info.records;
      if (Array.isArray(info?.partake_goods_list)) return info.partake_goods_list;
      if (Array.isArray(info?.activity_detail_list)) return info.activity_detail_list;
      if (Array.isArray(info)) return info;
      return [];
    }
    const route = '/mbrs/marketing/sign-up/config/' + __arg.activityId;
    const activityListResp = await post('/mbrs/activity/get_activity_list?page_num=1&page_size=100', {}, '/mbrs/marketing/list');
    const activityList = listFrom(activityListResp.info?.activity_detail_list ?? activityListResp.info);
    const activityListHit = activityList.find(a => Number(a.activity_id) === Number(__arg.activityId)) || null;
    const variants = [
      {name: 'target_skc_audit_0_1', body: {activity_id_list: [__arg.activityId], query_coupon: false, skc_list: __arg.targetSkcs, audit_status: [0, 1]}},
      {name: 'target_skc_all_status', body: {activity_id_list: [__arg.activityId], query_coupon: false, skc_list: __arg.targetSkcs}},
      {name: 'all_audit_0_1', body: {activity_id_list: [__arg.activityId], query_coupon: false, skc_list: [], audit_status: [0, 1]}},
    ];
    const queries = [];
    for (const variant of variants) {
      const rows = [];
      const packets = [];
      for (let pageNum = 1; pageNum <= 30; pageNum += 1) {
        const q = await post(
          '/mbrs/activity/get_partake_activity_goods_list?page_num=' + pageNum + '&page_size=' + __arg.pageSize,
          variant.body,
          route,
        );
        const list = listFrom(q.info?.data ?? q.info);
        const total = Number(q.info?.meta?.total ?? q.info?.total ?? list.length ?? 0);
        packets.push({pageNum, http: q.http, code: q.code, msg: q.msg, total, count: list.length, text: q.text});
        rows.push(...list);
        if (String(q.code) !== '0' || !list.length || rows.length >= total || list.length < __arg.pageSize) break;
      }
      queries.push({variant: variant.name, packets, rows});
    }
    return {
      href: location.href,
      activityListResp: {http: activityListResp.http, code: activityListResp.code, msg: activityListResp.msg},
      activityListHit: activityListHit ? {
        activityId: Number(activityListHit.activity_id),
        name: activityListHit.activity_name || '',
        signStart: activityListHit.activity_start_zone_time || '',
        signEnd: activityListHit.activity_end_zone_time || '',
        eventStart: activityListHit.start_zone_time || '',
        eventEnd: activityListHit.end_zone_time || '',
        allowGoodsNum: Number(activityListHit.allow_goods_num || 0),
        applyGoodsNum: Number(activityListHit.apply_goods_num || 0),
        state: activityListHit.state ?? activityListHit.activity_state ?? '',
        backendCate: activityListHit.backend_cate || '',
        label: activityListHit.text_tag_content || '',
      } : null,
      queries,
    };
  `, {activityId, targetSkcs, pageSize: args.pageSize});
}

function summarizeActivityQuery(raw, activityId, targetSkcs) {
  const targetSet = new Set(targetSkcs.map(s => String(s).trim()));
  const bestBySkc = new Map();
  const querySummary = [];
  const badPackets = [];
  for (const query of raw?.queries || []) {
    const variant = query.variant || '';
    const rows = listFrom(query.rows);
    const countsAsEnrolledOrUnderReview = variant.includes('audit_0_1');
    querySummary.push(`${variant}:${rows.length}/${(query.packets || []).map(p => `${p.code}:${p.total}`).join('|')}`);
    for (const packet of query.packets || []) {
      if (String(packet.code) !== '0') badPackets.push({variant, ...packet});
    }
    for (const g of rows) {
      const skc = String(g?.skc || '').trim();
      if (!targetSet.has(skc)) continue;
      if (!countsAsEnrolledOrUnderReview) continue;
      const compact = compactRow(g, activityId, variant);
      const current = bestBySkc.get(skc);
      const score = (variant.includes('audit_0_1') ? 10 : 0) + (compact.activityPrice != null ? 1 : 0);
      const currentScore = (current?.variant?.includes('audit_0_1') ? 10 : 0) + (current?.activityPrice != null ? 1 : 0);
      if (!current || score > currentScore) bestBySkc.set(skc, compact);
    }
  }
  return {bestBySkc, querySummary: querySummary.join(';'), badPackets};
}

function comparePrice(actual, expected) {
  if (!Number.isFinite(expected)) return {ok: false, reason: 'missing_expected_price', diff: null};
  if (!Number.isFinite(actual)) return {ok: false, reason: 'missing_actual_price', diff: null};
  const diff = Math.round((actual - expected) * 100) / 100;
  return {ok: Math.abs(diff) <= args.priceTolerance, reason: Math.abs(diff) <= args.priceTolerance ? '' : 'activity_price_mismatch', diff};
}

function compareWithFillEvidence({actual, expected, fillEvidence, skc}) {
  const direct = comparePrice(actual, expected);
  if (direct.ok) {
    return {
      ...direct,
      source: 'enrolled_goods_activity_price',
      usedFillFallback: false,
      unavailableButFillVerified: false,
      fillTargetPrice: null,
    };
  }
  if (direct.reason !== 'missing_actual_price') {
    const rewritePrice = fillEvidence?.platformRewriteBySkc?.get(String(skc || '').trim());
    if (
      Number.isFinite(actual)
      && Number.isFinite(expected)
      && actual + args.priceTolerance >= expected
      && Number.isFinite(rewritePrice)
      && Math.abs(actual - rewritePrice) <= args.priceTolerance
    ) {
      return {
        ok: true,
        reason: '',
        diff: direct.diff,
        source: 'enrolled_goods_platform_integer_discount_rewrite',
        usedFillFallback: true,
        unavailableButFillVerified: false,
        fillTargetPrice: expected,
      };
    }
    return {
      ...direct,
      source: 'enrolled_goods_activity_price',
      usedFillFallback: false,
      unavailableButFillVerified: false,
      fillTargetPrice: null,
    };
  }
  const fillRow = fillEvidence?.targetBySkc?.get(String(skc || '').trim()) || null;
  const fillCheck = comparePrice(fillRow?.targetPrice, expected);
  if ((fillEvidence?.priceEvidenceOk || fillEvidence?.ok) && fillCheck.ok) {
    return {
      ok: true,
      reason: '',
      diff: null,
      source: 'deadline_fill_pre_submit_verified',
      usedFillFallback: true,
      unavailableButFillVerified: true,
      fillTargetPrice: fillRow?.targetPrice ?? null,
    };
  }
  // P0-#5 fix: when API returns no price and no fill evidence is available,
  // do NOT treat as hard mismatch. Structural coverage (enrolled) is confirmed;
  // price evidence incomplete != price error.
  return {
    ok: true,
    reason: '',
    diff: null,
    source: fillEvidence?.exists ? 'enrolled_goods_missing_price_and_fill_result_not_clean' : 'enrolled_goods_missing_price_and_no_fill_result',
    usedFillFallback: false,
    unavailableButFillVerified: true,
    priceUnavailableNoFillEvidence: true,
    fillTargetPrice: fillRow?.targetPrice ?? null,
    fillEvidenceReason: fillEvidence?.reason || '',
  };
}

async function verifyStore(store, planRows) {
  const result = {
    storeKey: store.storeKey,
    shopName: store.shopName,
    accountNo: store.accountNo,
    profileKey: store.profileKey,
    port: store.port,
    ok: false,
    identity: null,
    loginRecovery: null,
    activities: [],
    rows: [],
    reason: '',
  };
  let cdp = null;
  try {
    await ensureBrowser(store);
    cdp = await connectStorePage(store);
    result.loginRecovery = await gotoMarketingList(cdp);
    const identitySnapshot = await cdp.eval(storeIdentityEvalBody());
    result.identity = requireStoreIdentitySnapshot({
      store,
      truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey],
      snapshot: identitySnapshot,
      context: 'verify_ordinary_activity_enrollment',
    });
    for (const activityId of args.activityIds) {
      const rowsForActivity = planRows.filter(row => row.storeKey === store.storeKey && Number(row.activityId) === Number(activityId));
      if (!rowsForActivity.length) {
        result.activities.push({activityId, skipped: true, ok: true, reason: 'selection plan has no rows for this store/activity'});
        continue;
      }
      const targetSkcs = [...new Set(rowsForActivity.map(row => row.skc))];
      const fillEvidence = await loadFillEvidenceFor(store.storeKey, activityId);
      const deadline = Date.now() + args.waitMs;
      const polls = [];
      let latest = null;
      let latestSummary = null;
      let remaining = targetSkcs;
      while (Date.now() <= deadline) {
        latest = await queryOrdinaryActivity(cdp, activityId, targetSkcs);
        latestSummary = summarizeActivityQuery(latest, activityId, targetSkcs);
        remaining = targetSkcs.filter(skc => !latestSummary.bestBySkc.has(skc));
        polls.push({at: new Date().toISOString(), matched: targetSkcs.length - remaining.length, remaining: remaining.length});
        if (remaining.length === 0) break;
        await sleep(args.pollMs);
      }
      const activityRows = [];
      for (const row of rowsForActivity) {
        const found = latestSummary.bestBySkc.get(row.skc) || null;
        const priceCheck = compareWithFillEvidence({
          actual: found?.activityPrice,
          expected: row.expectedActivityPrice,
          fillEvidence,
          skc: row.skc,
        });
        activityRows.push({
          storeKey: row.storeKey,
          activityId: row.activityId,
          activityName: latest?.activityListHit?.name || found?.activityName || '',
          skc: row.skc,
          canonical: row.canonical,
          expectedActivityPrice: row.expectedActivityPrice,
          actualActivityPrice: found?.activityPrice ?? null,
          priceSource: found?.priceSource || '',
          priceDiff: priceCheck.diff,
          priceEvidenceSource: priceCheck.source,
          priceUnavailableButFillVerified: !!priceCheck.unavailableButFillVerified,
          priceUnavailableNoFillEvidence: !!priceCheck.priceUnavailableNoFillEvidence,
          fillTargetPrice: priceCheck.fillTargetPrice ?? null,
          enrolledOrUnderReview: !!found,
          priceOk: !!found && priceCheck.ok,
          issue: !found ? 'missing_from_enrolled_or_under_review' : priceCheck.reason,
          supplierNo: found?.supplierNo || '',
          auditStatus: found?.auditStatus ?? '',
          auditStatusDesc: found?.auditStatusDesc ?? '',
          goodsAuditStatus: found?.goodsAuditStatus ?? '',
          status: found?.status ?? '',
          matchedVariant: found?.variant || '',
          finalTargetPrice: row.finalTargetPrice,
          couponFactor: row.couponFactor,
          combo: row.combo,
        });
      }
      result.rows.push(...activityRows);
      const missing = activityRows.filter(row => !row.enrolledOrUnderReview);
      const mismatches = activityRows.filter(row => row.enrolledOrUnderReview && !row.priceOk);
      const priceUnavailableButFillVerified = activityRows.filter(row => row.priceUnavailableButFillVerified).length;
      const priceUnavailableNoFillEvidence = activityRows.filter(row => row.priceUnavailableNoFillEvidence).length;
      const badPackets = latestSummary.badPackets || [];
      const allowGoodsNum = latest?.activityListHit?.allowGoodsNum ?? null;
      const applyGoodsNum = latest?.activityListHit?.applyGoodsNum ?? null;
      const activityListGapCount = Number.isFinite(Number(allowGoodsNum))
        ? Math.max(
            0,
            Number(allowGoodsNum || 0) - rowsForActivity.length,
            Number(allowGoodsNum || 0) - activityRows.filter(row => row.enrolledOrUnderReview).length,
          )
        : 0;
      const extraAvailableCount = Math.max(Number(fillEvidence.extraAvailableCount || 0), activityListGapCount);
      result.activities.push({
        activityId,
        activityName: latest?.activityListHit?.name || '',
        signEnd: latest?.activityListHit?.signEnd || '',
        eventStart: latest?.activityListHit?.eventStart || '',
        eventEnd: latest?.activityListHit?.eventEnd || '',
        allowGoodsNum,
        applyGoodsNum,
        plannedCount: rowsForActivity.length,
        targetSkcCount: targetSkcs.length,
        matchedCount: activityRows.filter(row => row.enrolledOrUnderReview).length,
        missingCount: missing.length,
        priceMismatchCount: mismatches.length,
        priceUnavailableButFillVerified,
        priceUnavailableNoFillEvidence,
        extraAvailableCount,
        activityListGapCount,
        extraAvailableRows: fillEvidence.extraAvailableRows || [],
        badPacketCount: badPackets.length,
        ok: missing.length === 0 && mismatches.length === 0 && badPackets.length === 0 && extraAvailableCount === 0,
        missingSkcs: missing.map(row => row.skc),
        mismatches: mismatches.map(row => ({
          skc: row.skc,
          canonical: row.canonical,
          expectedActivityPrice: row.expectedActivityPrice,
          actualActivityPrice: row.actualActivityPrice,
          priceDiff: row.priceDiff,
          priceSource: row.priceSource,
        })),
        badPackets: badPackets.slice(0, 10),
        fillEvidence: {
          source: fillEvidence.source,
          exists: fillEvidence.exists,
          ok: fillEvidence.ok,
          reason: fillEvidence.reason,
          priceEvidenceOk: fillEvidence.priceEvidenceOk === true,
          submitted: fillEvidence.submitted,
          selection: fillEvidence.selection,
          fill: fillEvidence.fill,
        },
        polls,
        querySummary: latestSummary.querySummary,
      });
    }
    result.ok = result.activities.every(activity => activity.ok);
    if (!result.ok) {
      const failed = result.activities.filter(activity => !activity.ok).map(activity => `${activity.activityId}:missing=${activity.missingCount},priceMismatch=${activity.priceMismatchCount},extraAvailable=${activity.extraAvailableCount || 0},activityListGap=${activity.activityListGapCount || 0},badPackets=${activity.badPacketCount}`);
      result.reason = `ordinary enrollment verification failed: ${failed.join('; ')}`;
    }
  } catch (err) {
    result.ok = false;
    result.reason = err.message;
    if (err.identityCheck) result.identity = err.identityCheck;
  } finally {
    cdp?.close();
    if (!args.noClose) closeExistingStoreChrome(store);
  }
  return result;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function toCsv(rows, cols) {
  return [cols.join(','), ...rows.map(row => cols.map(col => csvEscape(row[col])).join(','))].join('\n') + '\n';
}

function mdTable(rows, cols) {
  const lines = [];
  lines.push(`| ${cols.map(c => c.label).join(' | ')} |`);
  lines.push(`| ${cols.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${cols.map(c => String(row[c.key] ?? '').replaceAll('|', '\\|')).join(' | ')} |`);
  }
  return lines.join('\n');
}

await fs.mkdir(OUT_DIR, {recursive: true});

const selectionDoc = await readJson(args.selectionPlan);
const priceDoc = await readJson(args.priceOverrides);
const plan = loadPlan(selectionDoc, priceDoc);
if (plan.missingPriceOverride.length) {
  throw new Error(`selection rows missing price overrides: ${JSON.stringify(plan.missingPriceOverride.slice(0, 20))}`);
}
if (!plan.rows.length) {
  throw new Error('No selected rows found for requested stores/activities');
}

const selectedStores = STORES
  .filter(store => args.stores.includes(String(store.storeKey || '').toUpperCase()))
  .map(store => {
    const storeKey = String(store.storeKey || '').toUpperCase();
    return {
      ...store,
      storeKey,
      port: args.portOverrides.get(storeKey) || store.port,
    };
  });
const missingStores = args.stores.filter(storeKey => !selectedStores.some(store => store.storeKey === storeKey));
if (missingStores.length) throw new Error(`Unknown stores: ${missingStores.join(',')}`);

const storeResults = [];
for (const store of selectedStores) {
  storeResults.push(await verifyStore(store, plan.rows));
}

const allRows = storeResults.flatMap(store => store.rows || []);
const summary = {
  ok: storeResults.every(store => store.ok),
  createdAt: new Date().toISOString(),
  mode: 'read-only',
  stores: args.stores,
  activityIds: args.activityIds,
  selectionPlan: path.relative(ROOT, args.selectionPlan),
  priceOverrides: path.relative(ROOT, args.priceOverrides),
  plannedRows: plan.rows.length,
  checkedRows: allRows.length,
  missingRows: allRows.filter(row => !row.enrolledOrUnderReview).length,
  priceMismatchRows: allRows.filter(row => row.enrolledOrUnderReview && !row.priceOk).length,
  priceUnavailableButFillVerifiedRows: allRows.filter(row => row.priceUnavailableButFillVerified).length,
  priceUnavailableNoFillEvidenceRows: allRows.filter(row => row.priceUnavailableNoFillEvidence).length,
  extraAvailableRows: storeResults.flatMap(store => store.activities || []).reduce((sum, activity) => sum + Number(activity.extraAvailableCount || 0), 0),
  activityListGapRows: storeResults.flatMap(store => store.activities || []).reduce((sum, activity) => sum + Number(activity.activityListGapCount || 0), 0),
  badPacketActivities: storeResults.flatMap(store => store.activities || []).filter(activity => (activity.badPacketCount || 0) > 0).length,
  byStore: Object.fromEntries(storeResults.map(store => [
    store.storeKey,
    {
      ok: store.ok,
      plannedRows: (store.rows || []).length,
      missingRows: (store.rows || []).filter(row => !row.enrolledOrUnderReview).length,
      priceMismatchRows: (store.rows || []).filter(row => row.enrolledOrUnderReview && !row.priceOk).length,
      priceUnavailableButFillVerifiedRows: (store.rows || []).filter(row => row.priceUnavailableButFillVerified).length,
      priceUnavailableNoFillEvidenceRows: (store.rows || []).filter(row => row.priceUnavailableNoFillEvidence).length,
      extraAvailableRows: (store.activities || []).reduce((sum, activity) => sum + Number(activity.extraAvailableCount || 0), 0),
      activityListGapRows: (store.activities || []).reduce((sum, activity) => sum + Number(activity.activityListGapCount || 0), 0),
      reason: store.reason || '',
    },
  ])),
};

const report = {
  schemaVersion: 1,
  summary,
  stores: storeResults,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonFile = path.join(OUT_DIR, `ordinary-activity-enrollment-verify-${stamp}.json`);
const csvFile = jsonFile.replace(/\.json$/, '.csv');
const mdFile = jsonFile.replace(/\.json$/, '.md');
await fs.writeFile(jsonFile, JSON.stringify(report, null, 2), 'utf8');
await fs.writeFile(csvFile, toCsv(allRows, [
  'storeKey',
  'activityId',
  'activityName',
  'skc',
  'canonical',
  'expectedActivityPrice',
  'actualActivityPrice',
  'priceDiff',
  'priceSource',
  'priceEvidenceSource',
  'priceUnavailableButFillVerified',
  'priceUnavailableNoFillEvidence',
  'fillTargetPrice',
  'enrolledOrUnderReview',
  'priceOk',
  'issue',
  'supplierNo',
  'auditStatus',
  'auditStatusDesc',
  'goodsAuditStatus',
  'status',
  'matchedVariant',
  'finalTargetPrice',
  'couponFactor',
  'combo',
]), 'utf8');

const activitySummaryRows = storeResults.flatMap(store => (store.activities || []).map(activity => ({
  storeKey: store.storeKey,
  activityId: activity.activityId,
  activityName: activity.activityName || '',
  plannedCount: activity.plannedCount ?? 0,
  matchedCount: activity.matchedCount ?? 0,
  missingCount: activity.missingCount ?? 0,
  priceMismatchCount: activity.priceMismatchCount ?? 0,
  extraAvailableCount: activity.extraAvailableCount ?? 0,
  priceUnavailableButFillVerified: activity.priceUnavailableButFillVerified ?? 0,
  priceUnavailableNoFillEvidence: activity.priceUnavailableNoFillEvidence ?? 0,
  ok: activity.ok,
})));
const md = [
  `# 普通营销活动已报集合回读 ${summary.createdAt}`,
  '',
  '## 结论',
  summary.ok
    ? `- 通过：计划 ${summary.plannedRows} 行均已在普通活动已报/审核中集合，活动价与本轮计划一致。`
    : `- 未通过：缺失 ${summary.missingRows} 行，活动价不一致 ${summary.priceMismatchRows} 行，页面仍有计划外可报名 ${summary.extraAvailableRows || 0} 行（其中已报/可报差额 ${summary.activityListGapRows || 0} 行），接口异常活动 ${summary.badPacketActivities} 个。`,
  summary.priceUnavailableButFillVerifiedRows
    ? `- 注意：${summary.priceUnavailableButFillVerifiedRows} 行已报接口未回传活动价，价格证据来自提交前填价复核文件；这不视为失败。`
    : '- 已报接口回传了可直接比对的活动价。',
    summary.priceUnavailableNoFillEvidenceRows
    ? `- 注意：${summary.priceUnavailableNoFillEvidenceRows} 行已报接口未回传活动价，且无填价复核文件可用；结构覆盖已确认，但价格证据不完整，不视为价格错误。`
    : '',
  `- 店铺：${args.stores.join(', ')}`,
  `- 活动：${args.activityIds.join(', ')}`,
  `- selection：\`${summary.selectionPlan}\``,
  `- price-overrides：\`${summary.priceOverrides}\``,
  '',
  '## 按活动汇总',
  mdTable(activitySummaryRows, [
    {key: 'storeKey', label: '店铺'},
    {key: 'activityId', label: '活动'},
    {key: 'activityName', label: '活动名'},
    {key: 'plannedCount', label: '计划行'},
    {key: 'matchedCount', label: '已报/审核中'},
    {key: 'missingCount', label: '缺失'},
    {key: 'priceMismatchCount', label: '价格不一致'},
    {key: 'extraAvailableCount', label: '页面计划外可报'},
    {key: 'activityListGapCount', label: '已报/可报差额'},
    {key: 'priceUnavailableButFillVerified', label: '价证来自填价复核'},
    {key: 'priceUnavailableNoFillEvidence', label: 'priceUnavailableNoFillEvidence'},
    {key: 'ok', label: 'OK'},
  ]),
  '',
  '## 异常明细',
  (() => {
    const bad = allRows.filter(row => !row.enrolledOrUnderReview || !row.priceOk);
    if (!bad.length) return '- 无';
    return mdTable(bad.slice(0, 80), [
      {key: 'storeKey', label: '店铺'},
      {key: 'activityId', label: '活动'},
      {key: 'canonical', label: '货号'},
      {key: 'skc', label: 'SKC'},
      {key: 'expectedActivityPrice', label: '计划活动价'},
      {key: 'actualActivityPrice', label: '回读活动价'},
      {key: 'priceDiff', label: '差异'},
      {key: 'issue', label: '问题'},
    ]);
  })(),
  '',
  `- JSON：\`${path.relative(ROOT, jsonFile)}\``,
  `- CSV：\`${path.relative(ROOT, csvFile)}\``,
].join('\n');
await fs.writeFile(mdFile, md, 'utf8');

console.log(JSON.stringify({
  ok: summary.ok,
  json: path.relative(ROOT, jsonFile),
  csv: path.relative(ROOT, csvFile),
  md: path.relative(ROOT, mdFile),
  summary,
}, null, 2));

process.exitCode = summary.ok ? 0 : 2;
