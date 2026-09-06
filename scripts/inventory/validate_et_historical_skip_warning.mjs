#!/usr/bin/env node
// Read-only ET exception: the entire attempt made no new inventory intent.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {discoverInventoryJournalFiles, readInventoryIntentJournals, inventoryIntentScopeKey, inventoryScopeFromIntent} from '../../lib/durable_inventory_write.mjs';
import {stableInventoryHash, normalizeInventoryOccupancy} from '../../lib/inventory_replenishment_policy.mjs';

const check = (ok, reason) => { if (!ok) throw new Error(`ET_HISTORICAL_WARNING_INVALID:${reason}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
async function regular(file) {
  const stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink(), 'regular file required');
  return fs.readFile(file);
}

export async function validateEtHistoricalSkipWarning({planFile, resultFile, journalFile, intentId, mode, runDate, batchId, manifestHash}) {
  check(['candidate', 'bound'].includes(mode), 'mode');
  const [planBytes, resultBytes, journalBytes] = await Promise.all([planFile, resultFile, journalFile].map(regular));
  const plan = JSON.parse(planBytes), result = JSON.parse(resultBytes);
  check(journalBytes.at(-1) === 10, 'torn journal');
  const entries = journalBytes.toString().trimEnd().split('\n').map(line => JSON.parse(line));
  const start = entries.findIndex(e => e.kind === 'executor_run_intent' && e.intentId === intentId);
  check(start >= 0, 'run intent missing');
  const tail = entries.slice(start);
  const phases = tail.filter(e => e.kind === 'executor_run_intent');
  const run = phases.at(-1);
  check(phases.every(e => e.intentId === intentId), 'interleaved or later run');
  check(phases.map(e => e.phase).join(',') === (mode === 'bound' ? 'prepared,executing,not_submitted' : 'prepared,executing'), 'run phases');
  check(date(runDate) && /^[a-f0-9]{64}$/.test(manifestHash), 'date/manifest');
  check(phases.every(e => e.runDate === runDate && e.batchId === batchId && e.manifestHash === manifestHash
    && e.planHash === plan.payloadHash && e.actionCount === plan.actionable?.length
    && e.attemptId === run.attemptId && e.resultAttempt === run.resultAttempt), 'run binding');
  check(/^[0-9]+-[0-9]+$/.test(run.attemptId) && path.resolve(run.resultAttempt) === path.resolve(resultFile)
    && path.resolve(resultFile) === `${path.resolve(journalFile).replace(/\.journal\.ndjson$/, '')}.attempt-${run.attemptId}`, 'attempt path');
  // Allow only run metadata and exact no-write result rows. This rejects ANY
  // new intent/outcome/unknown event, including one with a different planHash.
  check(tail.every(e => e.kind === 'executor_run_intent' || e.kind === 'result'), 'current submission or unknown event');
  if (mode === 'bound') check(run.executorStatus === 1 && run.resultHash === hash(resultBytes) && !run.stableResult, 'bound result hash/status');
  check(plan.schemaVersion === 'et-low-inventory-safety-plan/v1' && plan.date === runDate
    && plan.executable === true && Array.isArray(plan.blockers) && plan.blockers.length === 0, 'ET plan');
  check(plan.executionConstraints?.decreaseOnly === true && plan.executionConstraints.triggerBatchId === batchId
    && plan.executionConstraints.triggerManifestHash === manifestHash, 'ET constraints');
  const expectedHash = stableInventoryHash({schemaVersion: plan.schemaVersion, date: plan.date, policyVersion: plan.policyVersion,
    actionable: plan.actionable, lowEtAllocations: plan.lowEtAllocations, etFactSource: plan.etFactSource,
    sourceEvidence: plan.sourceEvidence.map(({ageHours, manifestAgeSeconds, endpointAgeSeconds, ...e}) => e),
    executionConstraints: plan.executionConstraints});
  check(plan.payloadHash === expectedHash && result.planHash === expectedHash && result.policyVersion === plan.policyVersion, 'plan hash');
  check(result.schemaVersion === 'daily-inventory-replenishment-result/v1' && result.execute === true
    && result.executionMode === 'automatic' && stableInventoryHash(result.executionConstraints) === stableInventoryHash(plan.executionConstraints)
    && Array.isArray(result.unresolvedIntents) && result.unresolvedIntents.length === 0, 'result envelope');
  check(Number.isFinite(Date.parse(result.generatedAt)) && Date.parse(result.generatedAt) >= Date.parse(phases[0].recordedAt), 'result time');
  const rows = result.results;
  const audits = tail.filter(e => e.kind === 'result');
  check(Array.isArray(rows) && rows.length > 0 && rows.length === plan.actionable.length && audits.length === rows.length, 'complete row coverage');
  const planRows = new Map(plan.actionable.map(r => [inventoryIntentScopeKey(r), r]));
  check(planRows.size === rows.length, 'duplicate plan scope');
  const files = await discoverInventoryJournalFiles(journalFile, {includeAll: true,
    additionalDirectories: String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '').split(path.delimiter).filter(Boolean)});
  const evidence = await Promise.all(files.map(async file => ({file, digest: hash(await regular(file))})));
  const lifecycle = await readInventoryIntentJournals(files, {maxRunDate: runDate, currentJournalFile: journalFile,
    quarantineHistoricalDanglingSupersedes: true});
  const seen = new Set();
  let historicalSkipped = 0;
  for (const [index, row] of rows.entries()) {
    const key = inventoryIntentScopeKey(row), planned = planRows.get(key), audit = audits[index];
    check(planned && !seen.has(key) && ['storeKey', 'skc', 'skuCode'].every(k => typeof row[k] === 'string' && row[k] && row[k] === planned[k]), 'row identity');
    seen.add(key);
    check(integer(row.targetUsableInventory) && row.targetUsableInventory === planned.targetUsableInventory
      && row.ruleClass === planned.ruleClass && integer(planned.platformUsableInventory)
      && planned.platformUsableInventory > planned.targetUsableInventory, 'row target');
    check(audit.planHash === plan.payloadHash && audit.sequence === index + 1
      && stableInventoryHash(audit.row) === stableInventoryHash(row)
      && Date.parse(audit.recordedAt) >= Date.parse(phases[0].recordedAt)
      && Date.parse(audit.recordedAt) <= Date.parse(result.generatedAt), 'exact attempt result audit');
    check(row.writes === undefined || (Array.isArray(row.writes) && row.writes.length === 0), 'row writes');
    check(row.after === undefined, 'unexpected post readback');
    normalizeInventoryOccupancy(row.before);
    check(row.before?.ok === true && row.before.stockRowMissing === false && row.before.skuCode === row.skuCode
      && integer(row.before.totalUsableInventory), 'valid before');
    if (row.state === 'skipped_target_already_matched' || row.state === 'skipped_safety_no_increase') {
      check(row.state === 'skipped_target_already_matched' ? row.before.totalUsableInventory === row.targetUsableInventory
        : row.before.totalUsableInventory < row.targetUsableInventory, 'ordinary skip');
      check(![...lifecycle.pending.values()].some(i => inventoryIntentScopeKey(i) === key), 'ordinary skip pending scope');
      continue;
    }
    check(row.state === 'submitted_but_readback_pending' && row.historicalPending === true && row.disposition === 'skipped'
      && row.historicalIntentClosed !== true && date(row.historicalRunDate) && row.historicalRunDate < runDate, 'historical skip');
    const matches = [...lifecycle.intents.entries()].filter(([, i]) => i.intentId === row.historicalIntentId);
    check(matches.length === 1, 'unique historical intent');
    const [intentKey, old] = matches[0];
    check(lifecycle.pending.has(intentKey) && !lifecycle.terminalOutcomes.has(intentKey)
      && [...lifecycle.pending.values()].filter(i => inventoryIntentScopeKey(i) === key).length === 1, 'unique pending scope');
    check(inventoryIntentScopeKey(old) === key && old.runDate === row.historicalRunDate
      && old.targetUsableInventory === row.historicalTargetUsableInventory && integer(row.historicalTargetUsableInventory)
      && old.logicalActionKey === row.logicalActionKey && audit.logicalActionKey === old.logicalActionKey
      && old.idempotencyKey === row.idempotencyKey && old.requestPayloadHash === row.requestPayloadHash
      && (old.commandId || '') === row.historicalCommandId
      && typeof row.historicalJournalFile === 'string' && path.resolve(old.journalFile) === path.resolve(row.historicalJournalFile)
      && row.before.totalUsableInventory !== old.targetUsableInventory, 'historical binding');
    const scope = inventoryScopeFromIntent(old);
    check(!scope.warehouseCode || (row.before.warehouseCodes?.length === 1
      && String(row.before.warehouseCodes[0]).toUpperCase() === scope.warehouseCode), 'warehouse');
    historicalSkipped++;
  }
  check(historicalSkipped > 0, 'no historical skip');
  // Do not silently drop/relabel the executor's plan-absent pending inventory.
  check(Array.isArray(result.deferredHistorical), 'deferred list');
  const absent = [...lifecycle.pending.values()].filter(i => !planRows.has(inventoryIntentScopeKey(i)));
  check(absent.length === result.deferredHistorical.length, 'deferred coverage');
  const deferredSeen = new Set();
  for (const row of result.deferredHistorical) {
    const old = absent.find(i => i.intentId === row.intentId);
    check(old && !deferredSeen.has(row.intentId) && row.state === 'deferred_historical'
      && ['storeKey', 'skc', 'skuCode', 'runDate', 'planHash', 'logicalActionKey', 'targetUsableInventory', 'policyVersion', 'authorizationId']
        .every(k => row[k] === old[k]), 'deferred binding');
    deferredSeen.add(row.intentId);
  }
  for (const e of evidence) check(hash(await regular(e.file)) === e.digest, 'journal changed during validation');
  check(hash(await regular(resultFile)) === hash(resultBytes) && hash(await regular(planFile)) === hash(planBytes)
    && hash(await regular(journalFile)) === hash(journalBytes), 'artifact changed during validation');
  return {resultHash: hash(resultBytes), historicalSkipped, deferredHistorical: absent.length,
    total: rows.length, skipped: rows.length - historicalSkipped, executorStatus: 1};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planFile, resultFile, journalFile, intentId, mode, runDate, batchId, manifestHash] = process.argv.slice(2);
  try { console.log(JSON.stringify(await validateEtHistoricalSkipWarning({planFile, resultFile, journalFile, intentId, mode, runDate, batchId, manifestHash}))); }
  catch { console.error('ET historical skip warning evidence invalid; replay forbidden'); process.exitCode = 1; }
}
