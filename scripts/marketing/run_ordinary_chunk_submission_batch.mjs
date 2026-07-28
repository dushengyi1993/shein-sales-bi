#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  loadOrdinaryCampaignApproval,
  ordinaryCampaignRowKey,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function split(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function rowKey(row) {
  return ordinaryCampaignRowKey(row);
}

function parseArgs(argv) {
  const args = {
    stores: [], activities: [], selection: '', prices: '', approvalManifest: '', outDir: '',
    excludeTargets: [], resumeDirs: [], chunkSize: 20, concurrency: 3, visible: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--stores') args.stores = split(argv[++i]).map(value => value.toUpperCase());
    else if (key === '--activities') args.activities = split(argv[++i]).map(Number).filter(Boolean);
    else if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--approval-manifest') args.approvalManifest = path.resolve(argv[++i] || '');
    else if (key === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (key === '--exclude-targets') args.excludeTargets = split(argv[++i]).map(file => path.resolve(file));
    else if (key === '--resume-from') args.resumeDirs = split(argv[++i]).map(dir => path.resolve(dir));
    else if (key === '--chunk-size') args.chunkSize = Number(argv[++i] || 20);
    else if (key === '--concurrency') args.concurrency = Number(argv[++i] || 3);
    else if (key === '--visible') args.visible = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.stores.length || !args.activities.length || !args.selection || !args.prices || !args.approvalManifest || !args.outDir) {
    throw new Error('Required: --stores --activities --selection --prices --approval-manifest --out-dir');
  }
  if (!Number.isInteger(args.chunkSize) || args.chunkSize < 1 || args.chunkSize > 25) throw new Error('Invalid --chunk-size (1-25)');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 5) throw new Error('Invalid --concurrency (1-5)');
  return args;
}

async function collectSubmittedKeys(rootDir, expectedWorkFingerprint) {
  const keys = new Set();
  const pending = [rootDir];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try {
      entries = await fs.readdir(dir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let doc;
      try {
        doc = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      } catch {
        continue;
      }
      if (
        doc?.ok !== true
        || doc?.submit?.submitted !== true
        || doc?.executionWorkFingerprint !== expectedWorkFingerprint
      ) continue;
      const storeKey = String(doc.store || doc.storeKey || '').toUpperCase();
      const activityId = Number(doc.activity?.activityId || doc.activityId || 0);
      for (const target of Array.isArray(doc.fill?.targets) ? doc.fill.targets : []) {
        if (storeKey && activityId && target?.skc) {
          keys.add(`${storeKey}:${activityId}:${String(target.skc).toLowerCase()}`);
        }
      }
    }
  }
  return keys;
}

function runNode(commandArgs, label) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, commandArgs, {cwd: ROOT, windowsHide: true});
    child.stdout.on('data', chunk => process.stdout.write(`[${label}] ${chunk}`));
    child.stderr.on('data', chunk => process.stderr.write(`[${label}] ${chunk}`));
    child.on('exit', (code, signal) => resolve({code, signal}));
  });
}

async function readResult(dir, storeKey, activityId) {
  const file = path.join(dir, `${storeKey}-${activityId}.json`);
  try {
    return {file: path.relative(ROOT, file), doc: JSON.parse(await fs.readFile(file, 'utf8'))};
  } catch (error) {
    return {file: path.relative(ROOT, file), error: String(error?.message || error)};
  }
}

function subsetDoc(source, items, stores, activities, label) {
  return {
    ...source,
    items,
    stores,
    activityIds: activities,
    totals: {...(source.totals || {}), selectedRows: items.length},
    scope: {...(source.scope || {}), storeKeys: stores, phase: `${label}-authorized-chunk`, submit: true},
    baselineForNextOrdinaryActivity: false,
    baselineForLimitedDiscountFallback: false,
    executionStatus: 'authorized_chunk_pending_execution',
  };
}

const args = parseArgs(process.argv.slice(2));
const approval = await loadOrdinaryCampaignApproval({
  root: ROOT,
  manifestPath: args.approvalManifest,
  selectionPath: args.selection,
  pricesPath: args.prices,
});
const selectionDoc = approval.selection;
const priceDoc = approval.prices;
const approvedScopeRows = approval.selectionRows.filter(row => (
  args.stores.includes(String(row.storeKey || '').toUpperCase())
  && args.activities.includes(Number(row.activityId || 0))
));
if (!approvedScopeRows.length) throw new Error('Approved plan has no rows in the requested store/activity scope');
const excluded = new Set();
for (const file of args.excludeTargets) {
  const targets = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const target of targets) excluded.add(rowKey(target));
}
let resumedSubmittedRows = 0;
for (const dir of args.resumeDirs) {
  const submitted = await collectSubmittedKeys(dir, approval.workFingerprint);
  for (const key of submitted) {
    if (!excluded.has(key)) resumedSubmittedRows += 1;
    excluded.add(key);
  }
}
const selectedRows = (selectionDoc.items || []).filter(row => (
  row.selected !== false
  && args.stores.includes(String(row.storeKey || '').toUpperCase())
  && args.activities.includes(Number(row.activityId || 0))
  && !excluded.has(rowKey(row))
));
const selectedKeys = new Set(selectedRows.map(rowKey));
const pricesByKey = new Map((priceDoc.items || []).filter(row => selectedKeys.has(rowKey(row))).map(row => [rowKey(row), row]));
const missingPrices = selectedRows.filter(row => !pricesByKey.has(rowKey(row)));
if (missingPrices.length) throw new Error(`Missing price rows: ${JSON.stringify(missingPrices.slice(0, 20))}`);

const tasksByStore = new Map();
for (const storeKey of args.stores) tasksByStore.set(storeKey, []);
for (const storeKey of args.stores) {
  for (const activityId of args.activities) {
    const rows = selectedRows
      .filter(row => String(row.storeKey).toUpperCase() === storeKey && Number(row.activityId) === activityId)
      .sort((a, b) => String(a.skc).localeCompare(String(b.skc)));
    for (let offset = 0; offset < rows.length; offset += args.chunkSize) {
      const chunkRows = rows.slice(offset, offset + args.chunkSize);
      const number = Math.floor(offset / args.chunkSize) + 1;
      tasksByStore.get(storeKey).push({storeKey, activityId, number, rows: chunkRows});
    }
  }
}

await fs.mkdir(args.outDir, {recursive: true});
const results = [];
const stores = args.stores.filter(storeKey => tasksByStore.get(storeKey)?.length);
let cursor = 0;
console.log(`[CHUNK] PLAN stores=${stores.length} rows=${selectedRows.length} tasks=${[...tasksByStore.values()].reduce((sum, tasks) => sum + tasks.length, 0)} resumed=${resumedSubmittedRows}`);

async function worker() {
  while (cursor < stores.length) {
    const storeKey = stores[cursor++];
    for (const task of tasksByStore.get(storeKey)) {
      const label = `${storeKey}-${task.activityId}-chunk-${String(task.number).padStart(2, '0')}`;
      const taskDir = path.join(args.outDir, label);
      const planDir = path.join(taskDir, 'plans');
      const dryDir = path.join(taskDir, 'dry-run');
      const executeDir = path.join(taskDir, 'execute');
      await fs.mkdir(planDir, {recursive: true});
      const taskKeys = new Set(task.rows.map(rowKey));
      const priceRows = [...taskKeys].map(key => pricesByKey.get(key));
      const selectionFile = path.join(planDir, `selection-plan-${label}.json`);
      const priceFile = path.join(planDir, `price-overrides-${label}.json`);
      await Promise.all([
        fs.writeFile(selectionFile, `${JSON.stringify(subsetDoc(selectionDoc, task.rows, [storeKey], [task.activityId], label), null, 2)}\n`, 'utf8'),
        fs.writeFile(priceFile, `${JSON.stringify(subsetDoc(priceDoc, priceRows, [storeKey], [task.activityId], label), null, 2)}\n`, 'utf8'),
      ]);
      const runtimePort = storeKey === 'FY' ? ['--runtime-port', '9455'] : [];
      const base = [
        path.join(ROOT, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs'),
        '--stores', storeKey,
        '--activity', String(task.activityId),
        '--selection-plan', selectionFile,
        '--price-overrides', priceFile,
        '--approval-manifest', approval.manifestPath,
        '--execution-work-fingerprint', approval.workFingerprint,
        ...(args.visible ? [] : ['--headless']),
        ...runtimePort,
      ];
      console.log(`\n[CHUNK] DRY-RUN ${label} rows=${task.rows.length}`);
      const dryProcess = await runNode([...base, '--out-dir', dryDir], `${label}:dry`);
      const dry = await readResult(dryDir, storeKey, task.activityId);
      const result = {
        label, storeKey, activityId: task.activityId, chunk: task.number,
        rowCount: task.rows.length, skcs: task.rows.map(row => row.skc),
        dryProcess, dryFile: dry.file, dry: dry.doc || null, dryReadError: dry.error || '',
      };
      if (dryProcess.code !== 0 || !dry.doc?.ok) {
        result.status = 'dry_run_failed';
        results.push(result);
        console.log(`[CHUNK] BLOCKED ${label}: ${dry.doc?.reason || dry.error || 'unknown'}`);
        continue;
      }
      console.log(`[CHUNK] EXECUTE ${label}`);
      const executeProcess = await runNode([...base, '--submit', '--out-dir', executeDir], `${label}:execute`);
      const execute = await readResult(executeDir, storeKey, task.activityId);
      result.executeProcess = executeProcess;
      result.executeFile = execute.file;
      result.execute = execute.doc || null;
      result.executeReadError = execute.error || '';
      result.status = executeProcess.code === 0 && execute.doc?.ok && execute.doc?.submit?.submitted === true ? 'submitted' : 'execute_failed';
      results.push(result);
      console.log(`[CHUNK] ${result.status.toUpperCase()} ${label}`);
    }
  }
}

await Promise.all(Array.from({length: Math.min(args.concurrency, stores.length)}, () => worker()));
const summary = {
  createdAt: new Date().toISOString(),
  approvalManifest: path.relative(ROOT, approval.manifestPath),
  approvalManifestHash: approval.manifestHash,
  workFingerprint: approval.workFingerprint,
  selection: path.relative(ROOT, args.selection),
  prices: path.relative(ROOT, args.prices),
  stores,
  activities: args.activities,
  chunkSize: args.chunkSize,
  resumedSubmittedRows,
  plannedRows: selectedRows.length,
  chunks: results.length,
  submittedChunks: results.filter(row => row.status === 'submitted').length,
  submittedRows: results.filter(row => row.status === 'submitted').reduce((sum, row) => sum + row.rowCount, 0),
  dryRunFailedChunks: results.filter(row => row.status === 'dry_run_failed').length,
  executeFailedChunks: results.filter(row => row.status === 'execute_failed').length,
  results,
};
const summaryFile = path.join(args.outDir, 'chunk-submission-summary.json');
await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`\n[CHUNK] SUMMARY ${path.relative(ROOT, summaryFile)} submittedRows=${summary.submittedRows}/${summary.plannedRows} submittedChunks=${summary.submittedChunks}/${summary.chunks}`);
process.exitCode = summary.submittedRows === summary.plannedRows ? 0 : 2;
