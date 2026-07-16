#!/usr/bin/env node
/**
 * Orchestrate SHEIN OpenAPI product/link basics reconciliation for authorized stores.
 *
 * This is a read-only SHEIN workflow and writes only the OpenAPI parallel
 * warehouse layer (`fact.openapi_product_*`, `mart.openapi_product_reconciliation`).
 * It never writes production link/inventory facts and never changes SHEIN data.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT = path.join(ROOT, 'state', 'openapi-probes', 'product-reconciliation.latest.json');
const DEFAULT_STORES = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    stores: [],
    concurrency: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_CONCURRENCY || 2),
    fetchTimeoutMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_FETCH_TIMEOUT_MS || 20 * 60_000),
    loadTimeoutMs: Number(process.env.SHEIN_OPENAPI_PRODUCT_RECONCILE_LOAD_TIMEOUT_MS || 10 * 60_000),
    failFast: false,
    out: DEFAULT_OUT,
    maxDetails: 0,
    skipDetails: false,
    skipStock: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--fetch-timeout-ms') args.fetchTimeoutMs = Number(argv[++i]);
    else if (a === '--load-timeout-ms') args.loadTimeoutMs = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--no-out') args.out = '';
    else if (a === '--max-details') args.maxDetails = Number(argv[++i]);
    else if (a === '--skip-details') args.skipDetails = true;
    else if (a === '--skip-stock') args.skipStock = true;
    else if (a === '--fail-fast') args.failFast = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/run_shein_openapi_products_reconciliation.mjs
  node scripts/run_shein_openapi_products_reconciliation.mjs --stores DL,DX --max-details 30

Runs fetch_shein_openapi_products + load_shein_openapi_products_warehouse for
authorized stores. It writes only OpenAPI parallel warehouse tables and emits a
sanitized summary. Secrets are never printed.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  args.concurrency = Math.max(1, Math.min(4, Number.isFinite(args.concurrency) ? Math.trunc(args.concurrency) : 2));
  args.fetchTimeoutMs = Math.max(60_000, Number.isFinite(args.fetchTimeoutMs) ? Math.trunc(args.fetchTimeoutMs) : 20 * 60_000);
  args.loadTimeoutMs = Math.max(60_000, Number.isFinite(args.loadTimeoutMs) ? Math.trunc(args.loadTimeoutMs) : 10 * 60_000);
  args.maxDetails = Math.max(0, Number.isFinite(args.maxDetails) ? Math.trunc(args.maxDetails) : 0);
  return args;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
}

function isAuthorized(entry) {
  return Boolean(entry?.enabled)
    && Boolean(String(entry?.openKeyId || '').trim())
    && Boolean(String(entry?.secretKey || '').trim());
}

function tail(text, max = 4000) {
  const s = String(text || '');
  return s.length <= max ? s : s.slice(-max);
}

function runNodeStep(name, script, args, {timeoutMs}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let parsed = null;
      const text = stdout.trim();
      try { parsed = text ? JSON.parse(text) : null; }
      catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
        }
      }
      resolve({
        name,
        ok: code === 0 && !timedOut,
        code,
        signal: signal || null,
        timedOut,
        startedAt,
        endedAt: new Date().toISOString(),
        parsed,
        stdoutTail: parsed ? '' : tail(stdout),
        stderrTail: tail(stderr),
      });
    });
  });
}

async function runOneStore(storeKey, args) {
  const fetchArgs = [storeKey, '--config', args.config];
  if (args.maxDetails > 0) fetchArgs.push('--max-details', String(args.maxDetails));
  if (args.skipDetails) fetchArgs.push('--skip-details');
  if (args.skipStock) fetchArgs.push('--skip-stock');
  const fetchStep = await runNodeStep('fetch', 'fetch_shein_openapi_products.mjs', fetchArgs, {timeoutMs: args.fetchTimeoutMs});
  if (!fetchStep.ok) return {storeKey, status: 'fetch_failed', ok: false, fetchStep, loadStep: null};
  const loadStep = await runNodeStep('load', 'load_shein_openapi_products_warehouse.mjs', ['--store', storeKey, '--skip-ensure'], {timeoutMs: args.loadTimeoutMs});
  if (!loadStep.ok) return {storeKey, status: 'load_failed', ok: false, fetchStep, loadStep};
  const row = Array.isArray(loadStep.parsed?.reconciliation) ? loadStep.parsed.reconciliation[0] : null;
  return {
    storeKey,
    status: row?.status || 'loaded',
    ok: true,
    fetchStep: {
      ...fetchStep,
      parsed: fetchStep.parsed ? {
        ok: fetchStep.parsed.ok,
        storeKey: fetchStep.parsed.storeKey,
        savedTo: fetchStep.parsed.savedTo,
        latest: fetchStep.parsed.latest,
        summary: fetchStep.parsed.summary,
        warnings: fetchStep.parsed.warnings || [],
      } : null,
    },
    loadStep: {
      ...loadStep,
      parsed: loadStep.parsed ? {
        ok: loadStep.parsed.ok,
        storeKey: loadStep.parsed.storeKey,
        loadedFile: loadStep.parsed.loadedFile,
        rowCounts: loadStep.parsed.rowCounts,
        reconciliation: loadStep.parsed.reconciliation,
      } : null,
    },
    reconciliation: row,
  };
}

async function runQueue(stores, args) {
  const results = [];
  let cursor = 0;
  let stopped = false;
  async function worker() {
    while (!stopped) {
      const idx = cursor;
      cursor += 1;
      if (idx >= stores.length) return;
      const storeKey = stores[idx];
      console.log(`[openapi-products] start store=${storeKey}`);
      const result = await runOneStore(storeKey, args);
      results[idx] = result;
      console.log(`[openapi-products] done store=${storeKey} status=${result.status}`);
      if (!result.ok && args.failFast) stopped = true;
    }
  }
  await Promise.all(Array.from({length: Math.min(args.concurrency, stores.length)}, () => worker()));
  return results.filter(Boolean);
}

function publicResult(result) {
  return {
    storeKey: result.storeKey,
    ok: result.ok,
    status: result.status,
    fetch: result.fetchStep ? {
      ok: result.fetchStep.ok,
      code: result.fetchStep.code,
      timedOut: result.fetchStep.timedOut,
      startedAt: result.fetchStep.startedAt,
      endedAt: result.fetchStep.endedAt,
      savedTo: result.fetchStep.parsed?.savedTo || '',
      latest: result.fetchStep.parsed?.latest || '',
      summary: result.fetchStep.parsed?.summary || null,
      warnings: result.fetchStep.parsed?.warnings || [],
      stderrTail: result.fetchStep.stderrTail,
      stdoutTail: result.fetchStep.stdoutTail,
    } : null,
    load: result.loadStep ? {
      ok: result.loadStep.ok,
      code: result.loadStep.code,
      timedOut: result.loadStep.timedOut,
      startedAt: result.loadStep.startedAt,
      endedAt: result.loadStep.endedAt,
      rowCounts: result.loadStep.parsed?.rowCounts || null,
      reconciliation: result.loadStep.parsed?.reconciliation || [],
      stderrTail: result.loadStep.stderrTail,
      stdoutTail: result.loadStep.stdoutTail,
    } : null,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config, {});
const configured = new Map((Array.isArray(config?.stores) ? config.stores : [])
  .map(entry => [String(entry?.storeKey || '').trim().toUpperCase(), entry])
  .filter(([key]) => key));
const requested = (args.stores.length ? args.stores : DEFAULT_STORES).filter((x, i, arr) => arr.indexOf(x) === i);
const authorized = requested.filter(storeKey => isAuthorized(configured.get(storeKey)));
const skipped = requested
  .filter(storeKey => !isAuthorized(configured.get(storeKey)))
  .map(storeKey => ({storeKey, status: configured.has(storeKey) ? 'configured_disabled_or_incomplete' : 'missing_config'}));
if (!authorized.length) throw new Error(`No authorized stores found for requested set: ${requested.join(',')}`);

const startedAt = new Date().toISOString();
const ensureStep = await runNodeStep(
  'ensure',
  'load_shein_openapi_products_warehouse.mjs',
  ['--ensure-only'],
  {timeoutMs: args.loadTimeoutMs},
);
const results = ensureStep.ok ? await runQueue(authorized, args) : [];
const publicResults = results.map(publicResult);
const counts = publicResults.reduce((acc, r) => {
  acc.total += 1;
  if (r.ok) acc.succeeded += 1;
  else acc.failed += 1;
  if (r.status === 'matched') acc.matched += 1;
  if (r.status === 'warning') acc.warning += 1;
  if (r.status === 'missing_browser') acc.missingBrowser += 1;
  return acc;
}, {total: 0, succeeded: 0, failed: 0, matched: 0, warning: 0, missingBrowser: 0, skipped: skipped.length});

const output = {
  schemaVersion: 'shein-openapi-product-reconciliation-run/v1',
  ok: ensureStep.ok && counts.failed === 0,
  generatedAt: new Date().toISOString(),
  startedAt,
  endedAt: new Date().toISOString(),
  concurrency: args.concurrency,
  maxDetails: args.maxDetails,
  requestedStores: requested,
  authorizedStores: authorized,
  ensure: {
    ok: ensureStep.ok,
    code: ensureStep.code,
    timedOut: ensureStep.timedOut,
    startedAt: ensureStep.startedAt,
    endedAt: ensureStep.endedAt,
    stderrTail: ensureStep.stderrTail,
    stdoutTail: ensureStep.parsed ? '' : ensureStep.stdoutTail,
  },
  counts,
  skipped,
  results: publicResults,
};

if (args.out) {
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
