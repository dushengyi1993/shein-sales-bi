#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  loadOrdinaryCampaignApproval,
  ordinaryCampaignRowKey,
  stableOrdinaryCampaignPayload,
  validateOrdinaryCampaignDocuments,
} from '../../lib/marketing_ordinary_campaign_approval.mjs';
import {activityExecutionTransactionHash} from '../../lib/marketing_activity_inventory_integration.mjs';
import {executeOrdinaryActivityWithInventoryTransaction} from '../../lib/marketing_ordinary_activity_transaction_runner.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const args = {targets: '', plansDir: '', approvalManifest: '', outDir: '', concurrency: 3};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--targets') args.targets = path.resolve(argv[++i] || '');
    else if (key === '--plans-dir') args.plansDir = path.resolve(argv[++i] || '');
    else if (key === '--approval-manifest') args.approvalManifest = path.resolve(argv[++i] || '');
    else if (key === '--out-dir') args.outDir = path.resolve(argv[++i] || '');
    else if (key === '--concurrency') args.concurrency = Number(argv[++i] || 3);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.targets || !args.plansDir || !args.approvalManifest || !args.outDir) {
    throw new Error('Required: --targets --plans-dir --approval-manifest --out-dir');
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 5) throw new Error('Invalid --concurrency');
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

async function readResult(outDir, target) {
  const file = path.join(outDir, `${target.storeKey}-${target.activityId}.json`);
  try {
    return {file: path.relative(ROOT, file), doc: JSON.parse(await fs.readFile(file, 'utf8'))};
  } catch (error) {
    return {file: path.relative(ROOT, file), error: String(error?.message || error)};
  }
}

const args = parseArgs(process.argv.slice(2));
const targets = JSON.parse(await fs.readFile(args.targets, 'utf8'));
if (!Array.isArray(targets) || !targets.length) throw new Error('--targets must contain a non-empty JSON array');
const approval = await loadOrdinaryCampaignApproval({
  root: ROOT,
  manifestPath: args.approvalManifest,
});
for (const target of targets) {
  const key = ordinaryCampaignRowKey(target);
  if (!approval.selectionByKey.has(key) || !approval.priceByKey.has(key)) {
    throw new Error(`Singleton target is outside the approved plan: ${key}`);
  }
}
const grouped = new Map();
for (const target of targets) {
  const storeKey = String(target.storeKey || '').toUpperCase();
  if (!grouped.has(storeKey)) grouped.set(storeKey, []);
  grouped.get(storeKey).push({...target, storeKey});
}
await fs.mkdir(args.outDir, {recursive: true});
const storeGroups = [...grouped.entries()];
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < storeGroups.length) {
    const index = cursor++;
    const [storeKey, storeTargets] = storeGroups[index];
    for (const target of storeTargets) {
      const label = `${storeKey}-${target.activityId}-${target.skc}`;
      const selection = path.join(args.plansDir, `selection-plan-${label}.json`);
      const prices = path.join(args.plansDir, `price-overrides-${label}.json`);
      const [selectionDoc, pricesDoc] = await Promise.all([
        fs.readFile(selection, 'utf8').then(JSON.parse),
        fs.readFile(prices, 'utf8').then(JSON.parse),
      ]);
      const validatedSubset = validateOrdinaryCampaignDocuments(selectionDoc, pricesDoc);
      const targetKey = ordinaryCampaignRowKey(target);
      if (
        validatedSubset.selectionRows.length !== 1
        || validatedSubset.priceRows.length !== 1
        || validatedSubset.selectionKeys[0] !== targetKey
        || validatedSubset.priceKeys[0] !== targetKey
        || stableOrdinaryCampaignPayload(validatedSubset.selectionRows) !== stableOrdinaryCampaignPayload([approval.selectionByKey.get(targetKey)])
        || stableOrdinaryCampaignPayload(validatedSubset.priceRows) !== stableOrdinaryCampaignPayload([approval.priceByKey.get(targetKey)])
      ) {
        throw new Error(`Singleton plan does not exactly match approved row: ${targetKey}`);
      }
      const runtimePort = storeKey === 'FY' ? ['--runtime-port', '9455'] : [];
      const base = [
        path.join(ROOT, 'scripts', 'marketing', 'dsy_marketing_deadline_fill.mjs'),
        '--stores', storeKey,
        '--activity', String(target.activityId),
        '--selection-plan', selection,
        '--price-overrides', prices,
        '--approval-manifest', approval.manifestPath,
        '--execution-work-fingerprint', approval.workFingerprint,
        '--headless',
        ...runtimePort,
      ];
      const dryDir = path.join(args.outDir, label, 'dry-run');
      const executeDir = path.join(args.outDir, label, 'execute');
      console.log(`\n[SINGLETON] DRY-RUN ${label} ${target.canonical || ''}`);
      const dryProcess = await runNode([...base, '--out-dir', dryDir], `${label}:dry`);
      const dry = await readResult(dryDir, target);
      const rowResult = {target, dryProcess, dry: dry.doc || null, dryFile: dry.file, dryReadError: dry.error || ''};
      if (dryProcess.code !== 0 || !dry.doc?.ok) {
        rowResult.status = 'dry_run_failed';
        results.push(rowResult);
        console.log(`[SINGLETON] BLOCKED ${label}: ${dry.doc?.reason || dry.error || 'unknown'}`);
        continue;
      }
      console.log(`[SINGLETON] EXECUTE ${label}`);
      const transactionHash = activityExecutionTransactionHash(
        approval.workFingerprint,
        storeKey,
        target.activityId,
        target.skc,
        dry.doc?.selection?.activityInventoryTransactionPlan || null,
      );
      const transaction = await executeOrdinaryActivityWithInventoryTransaction({
        root: ROOT,
        storeKey,
        dryResults: [dry.doc],
        transactionHash,
        runSubmit: async () => {
          const lowEtEvidenceHash = dry.doc?.lowEtFastSellerPricePullback?.evidenceHash || '';
          const executeProcess = await runNode([
            ...base,
            '--submit',
            '--expected-low-et-evidence-hash', lowEtEvidenceHash,
            '--out-dir', executeDir,
          ], `${label}:execute`);
          const execute = await readResult(executeDir, target);
          return {
            ok: executeProcess.code === 0,
            executeProcess,
            execute: execute.doc || null,
            executeFile: execute.file,
            executeReadError: execute.error || '',
          };
        },
        runVerify: async ({phase}) => {
          const verify = await runNode([
            path.join(ROOT, 'scripts', 'marketing', 'verify_ordinary_activity_enrollment.mjs'),
            '--stores', storeKey,
            '--activity', String(target.activityId),
            '--selection-plan', selection,
            '--price-overrides', prices,
            '--wait-ms', '30000',
          ], `${label}:verify:${phase}`);
          return lastJson(verify.stdout)?.summary || {ok: false, reason: verify.stderr || 'verify output missing'};
        },
      });
      rowResult.inventoryTransaction = transaction;
      const submitted = transaction.submitResult || {};
      rowResult.executeProcess = submitted.executeProcess || null;
      rowResult.execute = submitted.execute || null;
      rowResult.executeFile = submitted.executeFile || '';
      rowResult.executeReadError = submitted.executeReadError || '';
      rowResult.status = transaction.ok === true && rowResult.execute?.ok && rowResult.execute?.submit?.submitted === true
        ? 'submitted'
        : 'execute_failed';
      results.push(rowResult);
      console.log(`[SINGLETON] ${rowResult.status.toUpperCase()} ${label}`);
    }
  }
}

await Promise.all(Array.from({length: Math.min(args.concurrency, storeGroups.length)}, () => worker()));
const summary = {
  createdAt: new Date().toISOString(),
  approvalManifest: path.relative(ROOT, approval.manifestPath),
  approvalManifestHash: approval.manifestHash,
  workFingerprint: approval.workFingerprint,
  targets: targets.length,
  submitted: results.filter(row => row.status === 'submitted').length,
  dryRunFailed: results.filter(row => row.status === 'dry_run_failed').length,
  executeFailed: results.filter(row => row.status === 'execute_failed').length,
  results,
};
const summaryFile = path.join(args.outDir, 'singleton-recovery-summary.json');
await fs.writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`\n[SINGLETON] SUMMARY ${path.relative(ROOT, summaryFile)} submitted=${summary.submitted}/${summary.targets} dryFailed=${summary.dryRunFailed} executeFailed=${summary.executeFailed}`);
process.exitCode = summary.submitted === summary.targets ? 0 : 2;
