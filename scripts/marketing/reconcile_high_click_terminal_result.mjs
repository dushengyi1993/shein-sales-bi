#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadExactHighClickSpecialPlan} from '../../lib/marketing_repair_manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APPROVED = new Map([
  ['TZZ::sv260517111710630319025', {kind: 'restored', activityId: 88109515}],
  ['JY::sv260304160168823801097', {kind: 'restored', activityId: 88109655}],
  ['TZZ::sv260520141087991852389', {kind: 'restored', activityId: 88109800}],
  ['YJ::sv260202233956355340972', {kind: 'prewrite_blocked_yj'}],
  ['DX::sv260128171583714957215', {kind: 'prewrite_blocked_dx'}],
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = () => String(argv[++i] || '').trim();
    if (key === '--date') out.date = value();
    else if (key === '--plan') out.plan = path.resolve(value());
    else if (key === '--guard') out.guard = path.resolve(value());
    else if (key === '--prior-result') out.priorResult = path.resolve(value());
    else if (key === '--prior-result-sha256') out.priorResultSha256 = value().toLowerCase();
    else if (key === '--prior-work-fingerprint') out.priorWorkFingerprint = value().toLowerCase();
    else if (key === '--current-work-fingerprint') out.currentWorkFingerprint = value().toLowerCase();
    else if (key === '--dx-evidence') out.dxEvidence = path.resolve(value());
    else if (key === '--dx-evidence-sha256') out.dxEvidenceSha256 = value().toLowerCase();
    else if (key === '--out') out.out = path.resolve(value());
    else throw new Error(`Unknown argument: ${key}`);
  }
  for (const name of ['date', 'plan', 'guard', 'priorResult', 'priorResultSha256', 'priorWorkFingerprint', 'currentWorkFingerprint', 'dxEvidence', 'dxEvidenceSha256', 'out']) {
    if (!out[name]) throw new Error(`Missing --${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('Invalid --date');
  for (const name of ['priorResultSha256', 'priorWorkFingerprint', 'currentWorkFingerprint', 'dxEvidenceSha256']) {
    if (!/^[a-f0-9]{64}$/.test(out[name])) throw new Error(`Invalid ${name}`);
  }
  return out;
}

async function readRegular(file, expectedSha) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Evidence must be a regular non-symlink file: ${file}`);
  const bytes = await fs.readFile(file);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (expectedSha && sha256 !== expectedSha) throw new Error(`Evidence SHA mismatch file=${file} expected=${expectedSha} actual=${sha256}`);
  return {bytes, sha256, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))};
}

function exactKey(storeKey, skc) {
  return `${String(storeKey || '').trim().toUpperCase()}::${String(skc || '').trim().toLowerCase()}`;
}

function assertRestored(row, expected) {
  const restore = row?.restoreResult;
  const readback = restore?.readback;
  const transaction = restore?.transaction;
  const inventory = restore?.inventoryTransaction;
  if (row?.status !== 'restored' || row?.ok !== true || Number(row?.currentActivityId) !== expected.activityId) throw new Error(`Restored tuple top-level mismatch: ${exactKey(row?.storeKey, row?.skc)}`);
  if (restore?.status !== 'restored' || restore?.ok !== true || readback?.ok !== true || Number(readback?.activityId) !== expected.activityId) throw new Error(`Restored tuple readback mismatch: ${exactKey(row?.storeKey, row?.skc)}`);
  if (JSON.stringify(readback?.rows) !== JSON.stringify([row.skc])) throw new Error(`Restored tuple rows mismatch: ${exactKey(row?.storeKey, row?.skc)}`);
  if (transaction?.ok !== true || transaction?.safe !== true || !['replaced_all', 'created_without_replacement'].includes(transaction?.status) || !Array.isArray(transaction?.uncoveredSkcs) || transaction.uncoveredSkcs.length !== 0) throw new Error(`Restored tuple transaction mismatch: ${exactKey(row?.storeKey, row?.skc)}`);
  if (inventory?.writeAttempted !== false) throw new Error(`Restored tuple inventory write mismatch: ${exactKey(row?.storeKey, row?.skc)}`);
}

function assertNoWriteEnvelope(row) {
  const restore = row?.restoreResult;
  if (row?.ok !== false || row?.currentActivityId !== null || restore?.ok !== false || restore?.transaction !== null || restore?.inventoryTransaction !== null || restore?.readback !== null) {
    throw new Error(`Blocked tuple is not proven prewrite: ${exactKey(row?.storeKey, row?.skc)}`);
  }
}

function assertYjBlocked(row) {
  assertNoWriteEnvelope(row);
  const dryRun = row?.restoreResult?.dryRun;
  const invalid = Array.isArray(dryRun?.validation?.invalid) ? dryRun.validation.invalid : [];
  const platform = invalid.some(item => item?.skc === row.skc && item?.error_code === 'mrs-simple_platform_limit_discounts-0006');
  const inventory = invalid.some(item => item?.skc === row.skc && item?.reason === 'inventory below configured activity stock' && Number(item?.inventory) === 6 && Number(item?.attendNum) === 10);
  if (row?.status !== 'failed' || row?.restoreResult?.status !== 'failed' || dryRun?.reason !== 'platform pre-validation failed; aborting before every write' || !platform || !inventory) throw new Error('YJ prewrite blocker evidence mismatch');
}

function assertDxBlocked(row, evidence) {
  assertNoWriteEnvelope(row);
  const text = JSON.stringify(evidence?.error || '');
  if (row?.status !== 'dry_run_blocked' || row?.restoreResult?.status !== 'dry_run_blocked') throw new Error('DX result blocker status mismatch');
  if (String(evidence?.storeKey || '').toUpperCase() !== 'DX' || evidence?.execute !== false || evidence?.automationAuthorization !== null || !String(evidence?.rescuePath || '').includes(row.skc) || !text.includes('/common/get_apollo_map 302') || !text.includes('20302') || !text.includes('子系统登录重定向')) throw new Error('DX prewrite companion evidence mismatch');
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.rename(temp, file);
}

const args = parseArgs(process.argv.slice(2));
const prior = await readRegular(args.priorResult, args.priorResultSha256);
const dx = await readRegular(args.dxEvidence, args.dxEvidenceSha256);
const exactPlan = await loadExactHighClickSpecialPlan({root: ROOT, planPath: args.plan, guardPath: args.guard, date: args.date});
if (exactPlan.workFingerprint !== args.currentWorkFingerprint) throw new Error(`Current work fingerprint mismatch expected=${args.currentWorkFingerprint} actual=${exactPlan.workFingerprint}`);
if (prior.value?.date !== args.date || prior.value?.execute !== true || prior.value?.workFingerprint !== args.priorWorkFingerprint || !Array.isArray(prior.value?.results)) throw new Error('Prior result identity mismatch');
const planKeys = [...new Set(exactPlan.entries.map(row => row.key))].sort();
const approvedKeys = [...APPROVED.keys()].sort();
if (JSON.stringify(planKeys) !== JSON.stringify(approvedKeys)) throw new Error(`Current exact plan key set mismatch: ${JSON.stringify(planKeys)}`);
const byKey = new Map(prior.value.results.map(row => [exactKey(row?.storeKey, row?.skc), row]));
if (byKey.size !== APPROVED.size || prior.value.results.length !== APPROVED.size) throw new Error('Prior result must contain exactly five unique tuples');
const results = [];
for (const entry of exactPlan.entries) {
  const expected = APPROVED.get(entry.key);
  const row = byKey.get(entry.key);
  if (!expected || !row) throw new Error(`Missing approved tuple: ${entry.key}`);
  if (expected.kind === 'restored') assertRestored(row, expected);
  else if (expected.kind === 'prewrite_blocked_yj') assertYjBlocked(row);
  else assertDxBlocked(row, dx.value);
  results.push(expected.kind === 'restored' ? row : {
    ...row,
    status: 'prewrite_blocked',
    reason: expected.kind === 'prewrite_blocked_yj' ? 'terminal_platform_and_inventory_prevalidation' : 'terminal_browser_identity_prevalidation',
    terminal: true,
    writeAttempted: false,
    classification: 'prewrite_blocked',
  });
}
const reconciliationPayload = {
  date: args.date,
  currentWorkFingerprint: exactPlan.workFingerprint,
  priorResultSha256: prior.sha256,
  priorWorkFingerprint: prior.value.workFingerprint,
  dxEvidenceSha256: dx.sha256,
  tuples: results.map(row => ({storeKey: row.storeKey, skc: row.skc, status: row.status, activityId: row.currentActivityId || null})),
};
const output = {
  createdAt: new Date().toISOString(),
  date: args.date,
  guard: prior.value.guard || path.relative(ROOT, args.guard).replaceAll(path.sep, '/'),
  plan: exactPlan.planRelativePath,
  immutablePlanArtifact: prior.value.immutablePlanArtifact,
  workFingerprint: exactPlan.workFingerprint,
  execute: true,
  authorization: prior.value.authorization || null,
  reconciledNoBusinessExecution: true,
  reconciliation: {
    ...reconciliationPayload,
    priorResultPath: path.relative(ROOT, args.priorResult).replaceAll(path.sep, '/'),
    dxEvidencePath: path.relative(ROOT, args.dxEvidence).replaceAll(path.sep, '/'),
    reconciliationHash: crypto.createHash('sha256').update(JSON.stringify(reconciliationPayload)).digest('hex'),
  },
  totals: {planned: 5, processed: 5, processedThisRun: 0, resumedItems: 5, remainingItems: 0, restored: 3, alreadyCovered: 0, skippedNoLongerQualifies: 0, protectedByConcurrentManualSpecial: 0, blocked: 2, terminalBlocked: 2, failed: 0},
  results,
};
await writeAtomic(args.out, output);
const outBytes = await fs.readFile(args.out);
console.log(JSON.stringify({ok: true, out: args.out, sha256: crypto.createHash('sha256').update(outBytes).digest('hex'), workFingerprint: exactPlan.workFingerprint, totals: output.totals}, null, 2));
