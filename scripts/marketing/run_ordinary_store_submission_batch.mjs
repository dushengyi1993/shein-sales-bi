#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadOrdinaryCampaignApproval} from '../../lib/marketing_ordinary_campaign_approval.mjs';
import {activityExecutionTransactionHash} from '../../lib/marketing_activity_inventory_integration.mjs';
import {executeOrdinaryActivityWithInventoryTransaction} from '../../lib/marketing_ordinary_activity_transaction_runner.mjs';
import {
  scopeOrdinaryEnrollmentReadbackToApprovedRows,
  wrapOrdinaryEnrollmentReadbackForTransaction,
} from '../../lib/marketing_ordinary_enrollment_scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function split(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {stores: [], activities: [], selection: '', prices: '', approvalManifest: '', outDir: '', bi: '', inventoryTrend: '', concurrency: 3};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--stores') args.stores = split(argv[++i]).map(item => item.toUpperCase());
    else if (key === '--activities') args.activities = split(argv[++i]).map(Number).filter(Boolean);
    else if (key === '--selection') args.selection = path.resolve(argv[++i] || '');
    else if (key === '--prices') args.prices = path.resolve(argv[++i] || '');
    else if (key === '--approval-manifest') args.approvalManifest = path.resolve(argv[++i] || '');
    else if (key === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (key === '--bi') args.bi = path.resolve(argv[++i] || '');
    else if (key === '--inventory-trend') args.inventoryTrend = path.resolve(argv[++i] || '');
    else if (key === '--concurrency') args.concurrency = Number(argv[++i] || 3);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.stores.length || !args.activities.length || !args.selection || !args.prices || !args.approvalManifest || !args.outDir) {
    throw new Error('Required: --stores --activities --selection --prices --approval-manifest --out-dir');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 5) throw new Error('Invalid concurrency');
  return args;
}

function runNode(commandArgs, label) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, commandArgs, {cwd: ROOT, windowsHide: true});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      process.stderr.write(`[${label}] ${chunk}`);
    });
    child.on('exit', (code, signal) => resolve({ok: code === 0, code, signal, stdout, stderr}));
  });
}

function lastJson(text) {
  const source = String(text || '').trim();
  for (let i = source.lastIndexOf('{'); i >= 0; i = source.lastIndexOf('{', i - 1)) {
    try { return JSON.parse(source.slice(i)); } catch {}
  }
  return null;
}

async function cleanupStoreBrowser(storeKey) {
  return await runNode([
    path.join(ROOT, 'scripts', 'cleanup_shein_store_browsers.mjs'),
    '--store', storeKey,
    '--kill-after-sec', '5',
    '--json',
  ], `${storeKey}:browser-cleanup`);
}

async function newestSummary(dir) {
  try {
    const names = (await fs.readdir(dir)).filter(name => /^summary-.*\.json$/i.test(name)).sort();
    if (!names.length) return {error: 'summary_not_found'};
    const file = path.join(dir, names.at(-1));
    return {file: path.relative(ROOT, file), doc: JSON.parse(await fs.readFile(file, 'utf8'))};
  } catch (error) {
    return {error: String(error?.message || error)};
  }
}

function activityResults(summary) {
  return (summary?.stores || []).flatMap(store => store.results || []).filter(result => !result.skipped);
}

const args = parseArgs(process.argv.slice(2));
const approval = await loadOrdinaryCampaignApproval({
  root: ROOT,
  manifestPath: args.approvalManifest,
  selectionPath: args.selection,
  pricesPath: args.prices,
});
for (const storeKey of args.stores) {
  if (!approval.selectionRows.some(row => String(row.storeKey || '').toUpperCase() === storeKey)) {
    throw new Error(`Approved plan has no rows for requested store: ${storeKey}`);
  }
}
for (const activityId of args.activities) {
  if (!approval.selectionRows.some(row => Number(row.activityId || 0) === activityId)) {
    throw new Error(`Approved plan has no rows for requested activity: ${activityId}`);
  }
}
await fs.mkdir(args.outDir, {recursive: true});
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < args.stores.length) {
    const storeKey = args.stores[cursor++];
    let row = null;
    try {
    const base = [
      path.join(ROOT, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs'),
      '--stores', storeKey,
      '--activity', args.activities.join(','),
      '--selection-plan', args.selection,
      '--price-overrides', args.prices,
      '--approval-manifest', approval.manifestPath,
      '--execution-work-fingerprint', approval.workFingerprint,
      ...(args.bi ? ['--bi', args.bi] : []),
      ...(args.inventoryTrend ? ['--inventory-trend', args.inventoryTrend] : []),
      '--headless',
      '--no-close',
      ...(storeKey === 'FY' ? ['--runtime-port', '9455'] : []),
    ];
    const dryDir = path.join(args.outDir, storeKey, 'dry-run');
    const executeDir = path.join(args.outDir, storeKey, 'execute');
    console.log(`\n[STORE-BATCH] DRY-RUN ${storeKey}`);
    const dryProcess = await runNode([...base, '--out-dir', dryDir], `${storeKey}:dry`);
    const dry = await newestSummary(dryDir);
    const dryResults = activityResults(dry.doc);
    row = {storeKey, dryProcess, dryFile: dry.file || '', dryError: dry.error || '', dryResults};
    if (dryProcess.code !== 0 || !dryResults.length || dryResults.some(result => !result.ok)) {
      row.status = 'dry_run_failed';
      results.push(row);
      console.log(`[STORE-BATCH] BLOCKED ${storeKey}: ${dryResults.filter(result => !result.ok).map(result => `${result.activity?.activityId}:${result.reason || 'failed'}`).join(',') || dry.error}`);
      continue;
    }
    console.log(`[STORE-BATCH] EXECUTE ${storeKey}`);
    const transactionHash = activityExecutionTransactionHash(
      approval.workFingerprint,
      storeKey,
      args.activities,
      dryResults.map(result => result?.selection?.activityInventoryTransactionPlan || null),
    );
    const transaction = await executeOrdinaryActivityWithInventoryTransaction({
      root: ROOT,
      storeKey,
      dryResults,
      transactionHash,
      runSubmit: async () => {
        const lowEtEvidenceHash = dry.doc?.lowEtFastSellerPricePullback?.evidenceHash || '';
        const executeProcess = await runNode([
          ...base,
          '--submit',
          '--expected-low-et-evidence-hash', lowEtEvidenceHash,
          '--out-dir', executeDir,
        ], `${storeKey}:execute`);
        const execute = await newestSummary(executeDir);
        return {
          ok: executeProcess.code === 0,
          executeProcess,
          executeFile: execute.file || '',
          executeError: execute.error || '',
          executeResults: activityResults(execute.doc),
        };
      },
      runVerify: async ({phase}) => {
        const verify = await runNode([
          path.join(ROOT, 'scripts', 'marketing', 'verify_ordinary_activity_enrollment.mjs'),
          '--stores', storeKey,
          '--activity', args.activities.join(','),
          '--selection-plan', args.selection,
          '--price-overrides', args.prices,
          '--fill-results-dir', path.join(args.outDir, storeKey),
          '--wait-ms', '30000',
          '--no-close',
        ], `${storeKey}:verify:${phase}`);
        const summary = lastJson(verify.stdout)?.summary;
        const scoped = summary
          ? scopeOrdinaryEnrollmentReadbackToApprovedRows(summary)
          : {ok: false, reason: verify.stderr || 'verify output missing'};
        return wrapOrdinaryEnrollmentReadbackForTransaction(scoped);
      },
    });
    row.inventoryTransaction = transaction;
    const submitResult = transaction.submitResult || {};
    row.executeProcess = submitResult.executeProcess || null;
    row.executeFile = submitResult.executeFile || '';
    row.executeError = submitResult.executeError || '';
    row.executeResults = submitResult.executeResults || [];
    const platformSubmitted = Boolean(
      row.executeProcess?.code === 0
      && row.executeResults.length
      && row.executeResults.every(result => (
        result.ok
        && result.submit?.ok === true
        && result.submit?.submitted === true
        && result.submit?.state?.successUrl === true
      )),
    );
    row.status = transaction.ok === true && platformSubmitted
      ? 'submitted'
      : (platformSubmitted ? 'submitted_readback_failed' : 'execute_failed');
    results.push(row);
    console.log(`[STORE-BATCH] ${row.status.toUpperCase()} ${storeKey}`);
    } finally {
      const browserCleanup = await cleanupStoreBrowser(storeKey);
      if (row) row.browserCleanup = browserCleanup;
    }
  }
}

await Promise.all(Array.from({length: Math.min(args.concurrency, args.stores.length)}, () => worker()));
const summary = {
  createdAt: new Date().toISOString(),
  approvalManifest: path.relative(ROOT, approval.manifestPath),
  approvalManifestHash: approval.manifestHash,
  workFingerprint: approval.workFingerprint,
  stores: args.stores,
  submittedStores: results.filter(row => row.status === 'submitted').map(row => row.storeKey),
  submittedReadbackFailedStores: results.filter(row => row.status === 'submitted_readback_failed').map(row => row.storeKey),
  dryRunFailedStores: results.filter(row => row.status === 'dry_run_failed').map(row => row.storeKey),
  executeFailedStores: results.filter(row => row.status === 'execute_failed').map(row => row.storeKey),
  browserCleanupFailedStores: results.filter(row => row.browserCleanup?.code !== 0).map(row => row.storeKey),
  results,
};
const file = path.join(args.outDir, 'store-submission-summary.json');
await fs.writeFile(file, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(
  `\n[STORE-BATCH] SUMMARY ${path.relative(ROOT, file)} `
  + `verified=${summary.submittedStores.length}/${args.stores.length} `
  + `submitted_readback_failed=${summary.submittedReadbackFailedStores.length}`,
);
process.exitCode = summary.submittedStores.length === args.stores.length
  && summary.browserCleanupFailedStores.length === 0
  ? 0
  : 2;
