#!/usr/bin/env node
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue');

function parseArgs(argv) {
  const args = {
    guard: '',
    date: '',
    planDir: '',
    outDir: DEFAULT_OUT_DIR,
    stores: [],
    dryRunOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--guard') args.guard = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--guard=')) args.guard = path.resolve(arg.slice('--guard='.length));
    else if (arg === '--date') args.date = String(argv[++i] || '');
    else if (arg.startsWith('--date=')) args.date = String(arg.slice('--date='.length));
    else if (arg === '--plan-dir') args.planDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--plan-dir=')) args.planDir = path.resolve(arg.slice('--plan-dir='.length));
    else if (arg === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (arg.startsWith('--out-dir=')) args.outDir = path.resolve(arg.slice('--out-dir='.length));
    else if (arg === '--stores') args.stores = splitCsv(argv[++i]).map(store => store.toUpperCase());
    else if (arg.startsWith('--stores=')) args.stores = splitCsv(arg.slice('--stores='.length)).map(store => store.toUpperCase());
    else if (arg === '--dry-run-only') args.dryRunOnly = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.guard) throw new Error('Missing required --guard <marketing-daily-guard-YYYY-MM-DD.json>');
  if (!args.date) args.date = inferDateFromPath(args.guard);
  if (!args.date) throw new Error('Missing --date and could not infer YYYY-MM-DD from --guard path');
  return args;
}

function splitCsv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function inferDateFromPath(value) {
  const match = String(value || '').match(/20\d{2}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

async function runCommand(command, commandArgs, options = {}) {
  const timeoutMs = options.timeoutMs ?? 7200000;
  const startedAt = new Date().toISOString();
  return await new Promise(resolve => {
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore kill races
      }
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ok: false, exitCode: null, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr, error: error.message});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ok: code === 0 && !timedOut, exitCode: code, timedOut, startedAt, finishedAt: new Date().toISOString(), stdout, stderr});
    });
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try {
      return JSON.parse(source.slice(start));
    } catch {
      // continue scanning
    }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
if (!fssync.existsSync(args.guard)) throw new Error(`Guard report does not exist: ${args.guard}`);
await fs.mkdir(args.outDir, {recursive: true});

const guard = JSON.parse(await fs.readFile(args.guard, 'utf8'));
const belowRows = (guard.limitedDiscountTargetPriceDrift?.belowRows || [])
  .filter(row => row && row.storeKey && row.skc)
  .filter(row => Number(row.limitedDiscountPrice) < Number(row.finalTargetPrice) - 0.01);
const stores = [...new Set(belowRows.map(row => String(row.storeKey || '').toUpperCase()).filter(Boolean))].sort();
const outPath = path.join(args.outDir, `guard-limited-discount-drift-result-${args.date}.json`);

if (!belowRows.length) {
  const doc = {
    createdAt: new Date().toISOString(),
    guard: rel(args.guard),
    date: args.date,
    ok: true,
    action: 'none',
    reason: 'limitedDiscountTargetPriceDrift.belowRows is empty',
    drift: {belowRows: 0, stores: []},
  };
  await fs.writeFile(outPath, JSON.stringify(doc, null, 2), 'utf8');
  console.log(JSON.stringify({ok: true, action: 'none', out: rel(outPath), reason: doc.reason}, null, 2));
  process.exit(0);
}

const batchArgs = [
  'scripts/marketing/batch_fix_limited_discount_drift.mjs',
  '--guard',
  args.guard,
  '--date',
  args.date,
  '--out-dir',
  args.outDir,
];
if (args.planDir) batchArgs.push('--plan-dir', args.planDir);
if (args.stores.length) batchArgs.push('--stores', args.stores.join(','));
if (args.dryRunOnly) batchArgs.push('--dry-run-only');

const batch = await runCommand(process.execPath, batchArgs);
const parsed = parseLastJson(batch.stdout) || parseLastJson(batch.stderr);
const batchOut = parsed?.out ? path.resolve(ROOT, parsed.out) : path.join(args.outDir, `batch-drift-fix-result-${args.date}.json`);
let batchResult = null;
if (fssync.existsSync(batchOut)) {
  batchResult = JSON.parse(await fs.readFile(batchOut, 'utf8'));
}

const doc = {
  createdAt: new Date().toISOString(),
  guard: rel(args.guard),
  date: args.date,
  ok: batch.ok && !!batchResult?.totals && Number(batchResult.totals.storesFailed || 0) === 0,
  action: args.dryRunOnly ? 'dry_run_batch_fix' : 'batch_fix',
  drift: {
    belowRows: belowRows.length,
    stores,
  },
  command: {
    args: batchArgs,
    exitCode: batch.exitCode,
    timedOut: batch.timedOut,
    parsed,
  },
  batchResultPath: batchResult ? rel(batchOut) : '',
  summary: batchResult?.totals || null,
  statuses: batchResult?.totals?.statuses || null,
};
await fs.writeFile(outPath, JSON.stringify(doc, null, 2), 'utf8');
console.log(JSON.stringify({
  ok: doc.ok,
  action: doc.action,
  out: rel(outPath),
  batchResultPath: doc.batchResultPath,
  drift: doc.drift,
  summary: doc.summary,
}, null, 2));
if (!doc.ok) process.exitCode = 2;
