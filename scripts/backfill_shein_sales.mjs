#!/usr/bin/env node
/**
 * Backfill SHEIN store daily sales day-by-day with checkpointing.
 *
 * Examples:
 *   node scripts/backfill_shein_sales.mjs --stores DL,DX,FY --start 2026-03-01 --end 2026-03-31
 *   node scripts/backfill_shein_sales.mjs --all --start 2026-04-01 --end 2026-04-26 --status 当天同步
 *
 * The script intentionally runs sequentially. SHEIN sessions, phone-code
 * challenges, and Lark writes are easier to audit this way; speed is still
 * adequate because each store/day is a small API fetch.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storesConfig = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));

function parseArgs(argv) {
  const args = {
    status: '历史回补',
    sync: true,
    stopOnError: false,
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stores') args.stores = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--all') args.all = true;
    else if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--status') args.status = argv[++i];
    else if (a === '--no-sync') args.sync = false;
    else if (a === '--stop-on-error') args.stopOnError = true;
    else if (a === '--run-id') args.runId = argv[++i];
  }
  if (!args.start || !args.end) throw new Error('Missing --start/--end, date format YYYY-MM-DD');
  if (!args.all && !args.stores?.length) throw new Error('Use --stores DL,DX or --all');
  return args;
}

function* eachDate(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('Date must be YYYY-MM-DD');
  }
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

function selectedStores(args) {
  const enabled = storesConfig.stores.filter(s => s.enabled !== false);
  const stores = args.all ? enabled : args.stores.map(key => {
    const store = enabled.find(s => s.storeKey.toUpperCase() === key);
    if (!store) throw new Error(`Unknown or disabled store: ${key}`);
    return store;
  });
  return stores;
}

function runNode(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
  });
}

function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0);
  if (!starts.length) return null;
  try { return JSON.parse(s.slice(Math.min(...starts))); } catch { return null; }
}

async function saveState(stateFile, state) {
  await fs.mkdir(path.dirname(stateFile), {recursive: true});
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), 'utf8');
}

const args = parseArgs(process.argv.slice(2));
const stores = selectedStores(args);
const dates = [...eachDate(args.start, args.end)];
const stateFile = path.join(ROOT, 'state', 'backfill_runs', `${args.runId}.json`);
const state = {
  runId: args.runId,
  startedAt: new Date().toISOString(),
  updatedAt: null,
  start: args.start,
  end: args.end,
  status: args.status,
  sync: args.sync,
  stores: stores.map(s => s.storeKey),
  totalTasks: stores.length * dates.length,
  completed: 0,
  failed: 0,
  tasks: [],
};
await saveState(stateFile, state);

for (const store of stores) {
  for (const date of dates) {
    const task = {
      storeKey: store.storeKey,
      date,
      fetchOk: false,
      syncOk: false,
      salesSar: null,
      error: null,
      updatedAt: new Date().toISOString(),
    };
    const fetchResult = await runNode('fetch_shein_sales.mjs', [store.storeKey, '--date', date]);
    task.fetchStdout = fetchResult.stdout.slice(-1000);
    task.fetchStderr = fetchResult.stderr.slice(-1000);
    if (!fetchResult.ok) {
      task.error = `fetch failed: ${fetchResult.stderr || fetchResult.stdout}`;
      state.failed += 1;
      state.tasks.push(task);
      state.updatedAt = new Date().toISOString();
      await saveState(stateFile, state);
      if (/ECONNREFUSED|No Chrome page target|unsettled top-level await/i.test(task.error)) {
        state.skippedReason = `store ${store.storeKey} browser disconnected at ${date}`;
        state.updatedAt = new Date().toISOString();
        await saveState(stateFile, state);
        console.error(JSON.stringify({
          ok: false,
          storeKey: store.storeKey,
          date,
          error: 'browser_disconnected_or_hung',
          action: 'skip remaining dates for this store; relaunch/login then rerun remaining range',
        }));
        break;
      }
      if (args.stopOnError) throw new Error(task.error);
      continue;
    }
    task.fetchOk = true;
    const fetchJson = parseJsonFromOutput(fetchResult.stdout);
    task.salesSar = fetchJson?.totalSar ?? fetchJson?.daily?.[0]?.salesSar ?? null;

    if (args.sync) {
      const detailFile = path.join(ROOT, 'outputs', 'shein_fetch', store.storeKey, `${date}.json`);
      const syncResult = await runNode('sync_shein_daily_to_lark.mjs', ['--file', detailFile, '--status', args.status]);
      task.syncStdout = syncResult.stdout.slice(-1000);
      task.syncStderr = syncResult.stderr.slice(-1000);
      if (!syncResult.ok) {
        task.error = `sync failed: ${syncResult.stderr || syncResult.stdout}`;
        state.failed += 1;
        state.tasks.push(task);
        state.updatedAt = new Date().toISOString();
        await saveState(stateFile, state);
        if (args.stopOnError) throw new Error(task.error);
        continue;
      }
      task.syncOk = true;
    }

    state.completed += 1;
    state.tasks.push(task);
    state.updatedAt = new Date().toISOString();
    await saveState(stateFile, state);
    console.log(JSON.stringify({
      ok: true,
      storeKey: store.storeKey,
      date,
      salesSar: task.salesSar,
      completed: state.completed,
      failed: state.failed,
      total: state.totalTasks,
    }));
  }
}

state.finishedAt = new Date().toISOString();
state.finalStatus = state.failed ? 'finished_with_failures' : 'done';
await saveState(stateFile, state);

console.log(JSON.stringify({
  stateFile,
  finalStatus: state.finalStatus,
  completed: state.completed,
  failed: state.failed,
  totalTasks: state.totalTasks,
}, null, 2));
