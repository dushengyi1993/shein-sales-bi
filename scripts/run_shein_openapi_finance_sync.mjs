#!/usr/bin/env node
/** Orchestrate 19-store read-only finance collection and warehouse loading. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL_STORES = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];

function parseArgs(argv) {
  const args = {
    config: path.join(ROOT, 'config', 'shein_openapi.local.json'),
    stores: ALL_STORES,
    concurrency: Number(process.env.SHEIN_OPENAPI_FINANCE_CONCURRENCY || 3),
    timeoutMs: Number(process.env.SHEIN_OPENAPI_FINANCE_STORE_TIMEOUT_MS || 20 * 60_000),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') args.config = path.resolve(argv[++i]);
    else if (arg === '--date') args.start = args.end = argv[++i];
    else if (arg === '--start') args.start = argv[++i];
    else if (arg === '--end') args.end = argv[++i];
    else if (arg === '--stores') args.stores = String(argv[++i]).split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (arg === '--out') args.out = path.resolve(argv[++i]);
    else if (arg === '--fetch-only') args.fetchOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/run_shein_openapi_finance_sync.mjs --start 2026-07-01 --end 2026-07-18');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.start) throw new Error('--date or --start is required');
  if (!args.end) args.end = args.start;
  args.concurrency = Math.max(1, Math.min(5, Math.trunc(args.concurrency) || 3));
  return args;
}

function runNode(script, argv, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...argv], {cwd: ROOT, stdio: ['ignore','pipe','pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim()); } catch {}
      resolve({ok: code === 0 && !timedOut, code, timedOut, parsed, stdoutTail: parsed ? '' : stdout.slice(-3000), stderrTail: stderr.slice(-3000)});
    });
  });
}

async function runStore(storeKey, args) {
  const fetch = await runNode('fetch_shein_openapi_finance_check_orders.mjs', [storeKey, '--config', args.config, '--start', args.start, '--end', args.end], args.timeoutMs);
  if (!fetch.ok) return {storeKey, ok: false, status: 'fetch_failed', fetch};
  if (args.fetchOnly) return {storeKey, ok: true, status: 'fetched', fetch};
  const load = await runNode('load_shein_openapi_finance_warehouse.mjs', ['--store', storeKey], args.timeoutMs);
  if (!load.ok) return {storeKey, ok: false, status: 'load_failed', fetch, load};
  return {storeKey, ok: true, status: 'loaded', fetch, load};
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(args.config, 'utf8'));
  const configured = new Map((config.stores || []).map(row => [String(row.storeKey || '').toUpperCase(), row]));
  const stores = args.stores.filter(store => {
    const row = configured.get(store);
    return row?.enabled && row?.openKeyId && row?.secretKey;
  });
  const skipped = args.stores.filter(store => !stores.includes(store));
  const results = new Array(stores.length);
  let cursor = 0;
  async function worker() {
    while (cursor < stores.length) {
      const index = cursor++;
      const store = stores[index];
      console.error(`[finance-sync] start store=${store}`);
      results[index] = await runStore(store, args);
      console.error(`[finance-sync] done store=${store} status=${results[index].status}`);
    }
  }
  await Promise.all(Array.from({length: Math.min(args.concurrency, stores.length)}, () => worker()));
  const output = {
    schemaVersion: 'shein-openapi-finance-sync-run/v1',
    ok: results.every(row => row?.ok),
    start: args.start,
    end: args.end,
    generatedAt: new Date().toISOString(),
    requestedStores: args.stores,
    authorizedStores: stores,
    skippedStores: skipped,
    counts: {
      total: results.length,
      succeeded: results.filter(row => row?.ok).length,
      failed: results.filter(row => !row?.ok).length,
      checkOrders: results.reduce((sum, row) => sum + Number(row?.fetch?.parsed?.summary?.checkOrders || 0), 0),
      nonzeroReturnExpenseLines: results.reduce((sum, row) => sum + Number(row?.fetch?.parsed?.summary?.nonzeroReturnExpenseLines || 0), 0),
    },
    results,
  };
  if (args.out) {
    await fs.mkdir(path.dirname(args.out), {recursive: true});
    await fs.writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ok ? 0 : 1);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exit(1);
});
