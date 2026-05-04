#!/usr/bin/env node
/**
 * Unattended DSY history backfill plan.
 *
 * Runs the remaining DSY history ranges discovered on 2026-04-26, repairs
 * transient Lark sync failures, then refreshes monthly/store/product display
 * tables and writes SKU review reports.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs', 'history_backfill');
const REPORT_DIR = path.join(ROOT, 'outputs', 'reports');
const STATE_DIR = path.join(ROOT, 'state', 'backfill_runs');

function parseArgs(argv) {
  const args = {
    fromStep: 0,
    skipBackfill: false,
    refreshOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from-step') args.fromStep = Number(argv[++i]);
    else if (a === '--skip-backfill') args.skipBackfill = true;
    else if (a === '--refresh-only') {
      args.refreshOnly = true;
      args.skipBackfill = true;
    }
  }
  return args;
}

const HISTORY_BATCHES = [
  // Already completed before this orchestrator:
  // - DL 2025-09-26..2025-10-31
  // - LQ 2025-10-13..2025-10-31
  // - 2025-11 for DL/LQ/TS/MZ/DX/FY/NM, with one known transient sync repair below.
  {
    name: 'repair-lq-2025-11-30',
    type: 'repair-sync',
    store: 'LQ',
    date: '2025-11-30',
  },
  {
    name: 'dsy-2025-12',
    type: 'backfill',
    stores: ['DL', 'DX', 'FY', 'LQ', 'NM', 'TS', 'MZ'],
    start: '2025-12-01',
    end: '2025-12-31',
  },
  {
    name: 'dsy-2026-01',
    type: 'backfill',
    stores: ['DL', 'DX', 'FY', 'LQ', 'NM', 'TS', 'MZ'],
    start: '2026-01-01',
    end: '2026-01-31',
  },
  {
    name: 'dsy-2026-02-core',
    type: 'backfill',
    stores: ['DL', 'DX', 'FY', 'LQ', 'NM', 'TS', 'MZ'],
    start: '2026-02-01',
    end: '2026-02-28',
  },
  {
    name: 'dsy-2026-02-hl',
    type: 'backfill',
    stores: ['HL'],
    start: '2026-02-04',
    end: '2026-02-28',
  },
  {
    name: 'dsy-2026-04-all',
    type: 'backfill',
    stores: ['DL', 'DX', 'FY', 'LQ', 'NM', 'HL', 'JY', 'ZL', 'TS', 'MZ'],
    start: '2026-04-01',
    end: '2026-04-26',
  },
];

const MONTHS_TO_REFRESH = [
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
];

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runProcess(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      stdout += d;
      options.onStdout?.(d);
    });
    child.stderr.on('data', d => {
      stderr += d;
      options.onStderr?.(d);
    });
    child.on('error', err => resolve({ok: false, code: -1, stdout, stderr: String(err.stack || err)}));
    child.on('close', code => resolve({ok: code === 0, code, stdout, stderr}));
  });
}

function parseJsonFromOutput(text) {
  const s = String(text || '').trim();
  const starts = [s.lastIndexOf('\n{'), s.indexOf('{')].filter(i => i >= 0);
  if (!starts.length) return null;
  const start = s.lastIndexOf('\n{') >= 0 ? s.lastIndexOf('\n{') + 1 : s.indexOf('{');
  try { return JSON.parse(s.slice(start)); } catch { return null; }
}

async function appendLog(file, text) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.appendFile(file, text, 'utf8');
}

async function runLogged(stepName, script, args) {
  const logFile = path.join(LOG_DIR, `${timestamp()}-${stepName}.log`);
  await appendLog(logFile, `# ${stepName}\nnode ${script} ${args.join(' ')}\n\n`);
  const result = await runProcess(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    onStdout: d => appendLog(logFile, d),
    onStderr: d => appendLog(logFile, d),
  });
  await appendLog(logFile, `\n# exit=${result.code}\n`);
  return {...result, logFile};
}

async function repairFailedSyncs(stateFile, runSummary) {
  const repairs = [];
  let state = null;
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch {
    return repairs;
  }
  for (const task of state.tasks || []) {
    if (!task.fetchOk || task.syncOk || !task.storeKey || !task.date) continue;
    const detailFile = path.join(ROOT, 'outputs', 'shein_fetch', task.storeKey, `${task.date}.json`);
    let ok = false;
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      last = await runLogged(
        `repair-${task.storeKey}-${task.date}-attempt-${attempt}`,
        'sync_shein_daily_to_lark.mjs',
        ['--file', detailFile, '--status', '历史回补'],
      );
      if (last.ok) {
        ok = true;
        break;
      }
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
    repairs.push({storeKey: task.storeKey, date: task.date, ok, logFile: path.relative(ROOT, last?.logFile || '')});
  }
  runSummary.repairs.push(...repairs);
  return repairs;
}

async function runBackfillBatch(batch, runSummary) {
  const runId = `hist-${batch.name}`;
  const args = [
    '--stores', batch.stores.join(','),
    '--start', batch.start,
    '--end', batch.end,
    '--run-id', runId,
  ];
  const result = await runLogged(batch.name, 'backfill_shein_sales.mjs', args);
  const stateFile = path.join(STATE_DIR, `${runId}.json`);
  const parsedState = await fs.readFile(stateFile, 'utf8').then(s => JSON.parse(s)).catch(() => null);
  const item = {
    name: batch.name,
    type: batch.type,
    stores: batch.stores,
    start: batch.start,
    end: batch.end,
    ok: result.ok && parsedState?.finalStatus === 'done',
    finalStatus: parsedState?.finalStatus || null,
    completed: parsedState?.completed || 0,
    failed: parsedState?.failed || 0,
    stateFile: path.relative(ROOT, stateFile),
    logFile: path.relative(ROOT, result.logFile),
  };
  runSummary.steps.push(item);
  if (parsedState?.failed) {
    await repairFailedSyncs(stateFile, runSummary);
  }
  return item;
}

async function runRepairSync(batch, runSummary) {
  const detailFile = path.join(ROOT, 'outputs', 'shein_fetch', batch.store, `${batch.date}.json`);
  const result = await runLogged(batch.name, 'sync_shein_daily_to_lark.mjs', ['--file', detailFile, '--status', '历史回补']);
  const item = {
    name: batch.name,
    type: batch.type,
    store: batch.store,
    date: batch.date,
    ok: result.ok,
    logFile: path.relative(ROOT, result.logFile),
  };
  runSummary.steps.push(item);
  return item;
}

async function refreshMonth(month, runSummary) {
  const monthItem = {month, monthly: null, product: null, skuCandidates: null};
  const monthly = await runLogged(`refresh-monthly-${month}`, 'generate_monthly_sales_table.mjs', ['--month', month, '--dsy-only']);
  monthItem.monthly = {
    ok: monthly.ok,
    logFile: path.relative(ROOT, monthly.logFile),
    parsed: parseJsonFromOutput(monthly.stdout),
  };
  const product = await runLogged(`refresh-products-${month}`, 'sync_product_sales_to_lark.mjs', ['--month', month, '--group', 'DSY']);
  monthItem.product = {
    ok: product.ok,
    logFile: path.relative(ROOT, product.logFile),
    parsed: parseJsonFromOutput(product.stdout),
  };
  const sku = await runLogged(`sku-candidates-${month}`, 'report_product_sku_candidates.mjs', ['--month', month, '--group', 'DSY']);
  monthItem.skuCandidates = {
    ok: sku.ok,
    logFile: path.relative(ROOT, sku.logFile),
    parsed: parseJsonFromOutput(sku.stdout),
  };
  runSummary.monthRefresh.push(monthItem);
  return monthItem;
}

async function writeRunSummary(runSummary) {
  await fs.mkdir(REPORT_DIR, {recursive: true});
  const file = path.join(REPORT_DIR, `dsy-history-backfill-run-${runSummary.runId}.json`);
  runSummary.updatedAt = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(runSummary, null, 2), 'utf8');
  return file;
}

const args = parseArgs(process.argv.slice(2));
const runSummary = {
  runId: timestamp(),
  startedAt: new Date().toISOString(),
  args,
  steps: [],
  repairs: [],
  monthRefresh: [],
  finalSkuReview: null,
  errors: [],
};
let summaryFile = await writeRunSummary(runSummary);

try {
  if (!args.skipBackfill) {
    for (let i = args.fromStep; i < HISTORY_BATCHES.length; i++) {
      const batch = HISTORY_BATCHES[i];
      console.log(JSON.stringify({phase: 'batch_start', index: i, name: batch.name}));
      if (batch.type === 'backfill') await runBackfillBatch(batch, runSummary);
      else if (batch.type === 'repair-sync') await runRepairSync(batch, runSummary);
      summaryFile = await writeRunSummary(runSummary);
    }
  }

  for (const month of MONTHS_TO_REFRESH) {
    console.log(JSON.stringify({phase: 'refresh_month_start', month}));
    await refreshMonth(month, runSummary);
    summaryFile = await writeRunSummary(runSummary);
  }

  const finalSku = await runLogged('sku-candidates-all-history', 'report_product_sku_candidates.mjs', [
    '--start', '2025-09-01',
    '--end', '2026-04-26',
    '--group', 'DSY',
  ]);
  runSummary.finalSkuReview = {
    ok: finalSku.ok,
    logFile: path.relative(ROOT, finalSku.logFile),
    parsed: parseJsonFromOutput(finalSku.stdout),
  };
  runSummary.finishedAt = new Date().toISOString();
  runSummary.finalStatus = runSummary.errors.length || runSummary.steps.some(s => s.ok === false) || runSummary.monthRefresh.some(m => !m.monthly?.ok || !m.product?.ok || !m.skuCandidates?.ok) || !runSummary.finalSkuReview.ok
    ? 'finished_with_risks'
    : 'done';
} catch (err) {
  runSummary.errors.push(String(err.stack || err));
  runSummary.finishedAt = new Date().toISOString();
  runSummary.finalStatus = 'failed';
} finally {
  summaryFile = await writeRunSummary(runSummary);
}

console.log(JSON.stringify({
  ok: runSummary.finalStatus === 'done',
  finalStatus: runSummary.finalStatus,
  summaryFile: path.relative(ROOT, summaryFile),
  stepCount: runSummary.steps.length,
  repairs: runSummary.repairs,
  monthRefreshCount: runSummary.monthRefresh.length,
  finalSkuReview: runSummary.finalSkuReview?.parsed || null,
  errors: runSummary.errors,
}, null, 2));

if (runSummary.finalStatus === 'failed') process.exitCode = 1;
