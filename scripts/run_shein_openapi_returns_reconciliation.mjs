#!/usr/bin/env node
/**
 * Orchestrate SHEIN OpenAPI return-order double-run reconciliation.
 *
 * Read-only SHEIN workflow. It writes only isolated OpenAPI parallel tables:
 *   fact.openapi_return_order
 *   fact.openapi_return_item
 *   mart.openapi_return_reconciliation
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_STORES = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    stores: [],
    concurrency: Number(process.env.SHEIN_OPENAPI_RETURN_RECONCILE_CONCURRENCY || process.env.SHEIN_OPENAPI_RECONCILE_CONCURRENCY || 3),
    fetchTimeoutMs: Number(process.env.SHEIN_OPENAPI_RETURN_FETCH_TIMEOUT_MS || 10 * 60_000),
    loadTimeoutMs: Number(process.env.SHEIN_OPENAPI_RETURN_LOAD_TIMEOUT_MS || 10 * 60_000),
    failFast: false,
    out: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--fetch-timeout-ms') args.fetchTimeoutMs = Number(argv[++i]);
    else if (a === '--load-timeout-ms') args.loadTimeoutMs = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--fail-fast') args.failFast = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/run_shein_openapi_returns_reconciliation.mjs --date 2026-06-24
  node scripts/run_shein_openapi_returns_reconciliation.mjs --date 2026-06-24 --stores DL,DX --concurrency 2

Runs fetch_shein_openapi_returns + load_shein_openapi_returns_warehouse for
authorized stores. It never writes production browser/SHEIN facts.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (args.date) {
    args.start = args.date;
    args.end = args.date;
  }
  if (!args.start) throw new Error('Missing --date YYYY-MM-DD or --start/--end');
  if (!args.end) args.end = args.start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start)) throw new Error(`Invalid --start: ${args.start}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.end)) throw new Error(`Invalid --end: ${args.end}`);
  args.dates = [...eachDate(args.start, args.end)];
  if (!args.dates.length) throw new Error(`Empty date range: ${args.start}..${args.end}`);
  args.concurrency = Math.max(1, Math.min(5, Number.isFinite(args.concurrency) ? Math.trunc(args.concurrency) : 3));
  args.fetchTimeoutMs = Math.max(60_000, Number.isFinite(args.fetchTimeoutMs) ? Math.trunc(args.fetchTimeoutMs) : 10 * 60_000);
  args.loadTimeoutMs = Math.max(60_000, Number.isFinite(args.loadTimeoutMs) ? Math.trunc(args.loadTimeoutMs) : 10 * 60_000);
  return args;
}

function* eachDate(start, end) {
  const d = new Date(`${start}T00:00:00+08:00`);
  const stop = new Date(`${end}T00:00:00+08:00`);
  while (d <= stop) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    yield `${y}-${m}-${day}`;
    d.setDate(d.getDate() + 1);
  }
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
  const fetchStep = await runNodeStep('fetch', 'fetch_shein_openapi_returns.mjs', [storeKey, '--start', args.start, '--end', args.end], {timeoutMs: args.fetchTimeoutMs});
  if (!fetchStep.ok) return {storeKey, status: 'fetch_failed', ok: false, fetchStep, loadStep: null};
  const loadArgs = ['--store', storeKey, '--start', args.start, '--end', args.end];
  if (args.skipEnsureInWorkers) loadArgs.push('--skip-ensure');
  const loadStep = await runNodeStep('load', 'load_shein_openapi_returns_warehouse.mjs', loadArgs, {timeoutMs: args.loadTimeoutMs});
  if (!loadStep.ok) return {storeKey, status: 'load_failed', ok: false, fetchStep, loadStep};
  const reconciliationRows = Array.isArray(loadStep.parsed?.reconciliation) ? loadStep.parsed.reconciliation : [];
  const reconciliation = summarizeStoreReconciliation(reconciliationRows);
  return {
    storeKey,
    status: reconciliation?.status || 'loaded',
    ok: true,
    fetchStep: {
      ...fetchStep,
      parsed: fetchStep.parsed ? {
        ok: fetchStep.parsed.ok,
        storeKey: fetchStep.parsed.storeKey,
        outputs: (fetchStep.parsed.outputs || []).map(o => ({date: o.date, savedTo: o.savedTo, summary: o.summary})),
      } : null,
    },
    loadStep: {
      ...loadStep,
      parsed: loadStep.parsed ? {
        ok: loadStep.parsed.ok,
        storeKey: loadStep.parsed.storeKey,
        dates: loadStep.parsed.dates,
        rowCounts: loadStep.parsed.rowCounts,
        reconciliation: loadStep.parsed.reconciliation,
      } : null,
    },
    reconciliation,
  };
}

async function ensureWarehouseTablesOnce(args, firstStore) {
  // Run DDL once before parallel workers so CREATE TABLE/INDEX never happens
  // concurrently per store, avoiding PostgreSQL DDL deadlocks.
  return await runNodeStep('ensure', 'load_shein_openapi_returns_warehouse.mjs', ['--store', firstStore, '--date', args.start, '--ensure-only'], {timeoutMs: args.loadTimeoutMs});
}

function summarizeStoreReconciliation(rows) {
  if (!rows.length) return null;
  const badRows = rows.filter((row) => String(row?.status || '') !== 'matched' || String(row?.warnings || '').trim());
  const missingRows = rows.filter((row) => String(row?.status || '') === 'missing_browser');
  const target = badRows.at(-1) || rows.at(-1);
  const amountDelta = rows.reduce((sum, row) => sum + Number(row?.amountSarDelta || 0), 0);
  const browserOnlyReturnCount = rows.reduce((sum, row) => sum + Number(row?.browserOnlyReturnCount || 0), 0);
  const apiOnlyReturnCount = rows.reduce((sum, row) => sum + Number(row?.apiOnlyReturnCount || 0), 0);
  const status = missingRows.length ? 'missing_browser' : badRows.length ? 'warning' : 'matched';
  const warnings = [...new Set(rows.flatMap((row) => String(row?.warnings || '').split(';')).map((x) => x.trim()).filter(Boolean))];
  return {
    date: target?.date || rows.at(-1)?.date || '',
    status,
    warnings: warnings.join(';'),
    browserAmountSar: target?.browserAmountSar ?? null,
    apiAmountSar: target?.apiAmountSar ?? null,
    amountSarDelta: Math.round((amountDelta + Number.EPSILON) * 100) / 100,
    browserOnlyReturnCount,
    apiOnlyReturnCount,
    checkedDays: rows.length,
    warningDays: badRows.length,
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
      console.log(`[openapi-return-reconcile] start store=${storeKey} range=${args.start}..${args.end}`);
      const result = await runOneStore(storeKey, args);
      results[idx] = result;
      console.log(`[openapi-return-reconcile] done store=${storeKey} status=${result.status}`);
      if (!result.ok && args.failFast) stopped = true;
    }
  }
  const workers = Array.from({length: Math.min(args.concurrency, stores.length)}, () => worker());
  await Promise.all(workers);
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
      outputs: result.fetchStep.parsed?.outputs || [],
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

function publicStep(step) {
  if (!step) return null;
  return {
    ok: step.ok,
    code: step.code,
    timedOut: step.timedOut,
    startedAt: step.startedAt,
    endedAt: step.endedAt,
    stderrTail: step.stderrTail,
    stdoutTail: step.stdoutTail,
  };
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config, {});
const configured = new Map((Array.isArray(config?.stores) ? config.stores : [])
  .map(entry => [String(entry?.storeKey || '').trim().toUpperCase(), entry])
  .filter(([key]) => key));
const requested = (args.stores.length ? args.stores : DEFAULT_STORES).filter((x, i, arr) => arr.indexOf(x) === i);
const authorized = requested.filter(storeKey => isAuthorized(configured.get(storeKey)));
const skipped = requested.filter(storeKey => !isAuthorized(configured.get(storeKey))).map(storeKey => ({storeKey, status: configured.has(storeKey) ? 'configured_disabled_or_incomplete' : 'missing_config'}));
if (!authorized.length) throw new Error(`No authorized stores found for requested set: ${requested.join(',')}`);

const startedAt = new Date().toISOString();
const ensureStep = await ensureWarehouseTablesOnce(args, authorized[0]);
if (!ensureStep.ok) {
  const output = {
    schemaVersion: 'shein-openapi-return-reconciliation-run/v1',
    ok: false,
    date: args.dates.at(-1),
    start: args.start,
    end: args.end,
    dates: args.dates,
    generatedAt: new Date().toISOString(),
    startedAt,
    endedAt: new Date().toISOString(),
    concurrency: args.concurrency,
    requestedStores: requested,
    authorizedStores: authorized,
    counts: {total: 0, succeeded: 0, failed: 1, matched: 0, warning: 0, missingBrowser: 0, skipped: skipped.length},
    skipped,
    ensure: publicStep(ensureStep),
    results: [],
  };
  if (args.out) {
    await fs.mkdir(path.dirname(args.out), {recursive: true});
    await fs.writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(output, null, 2));
  process.exit(1);
}
args.skipEnsureInWorkers = true;
const results = await runQueue(authorized, args);
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
  schemaVersion: 'shein-openapi-return-reconciliation-run/v1',
  ok: counts.failed === 0,
  date: args.dates.at(-1),
  start: args.start,
  end: args.end,
  dates: args.dates,
  generatedAt: new Date().toISOString(),
  startedAt,
  endedAt: new Date().toISOString(),
  concurrency: args.concurrency,
  requestedStores: requested,
  authorizedStores: authorized,
  counts,
  skipped,
  ensure: publicStep(ensureStep),
  results: publicResults,
};

if (args.out) {
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(output, null, 2));
process.exit(output.ok ? 0 : 1);
