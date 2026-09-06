import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverInventoryJournalFiles} from './inventory_journal_discovery.mjs';
import {isInventoryPreSubmitExclusion, readInventoryIntentJournals} from './durable_inventory_write.mjs';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash} from './inventory_replenishment_policy.mjs';

const assert = (ok, reason) => { if (!ok) throw new Error('INVENTORY_DRY_RUN_INCOMPLETE:' + reason); };
const scope = row => JSON.stringify([row.storeKey, row.skc, row.skuCode]);
const noWrite = row => !row.intentId && !row.idempotencyKey && !row.logicalActionKey
  && !row.requestPayloadHash && (row.writes === undefined || (Array.isArray(row.writes) && row.writes.length === 0));

// A dry-run completion proves only that every plan row was checked. It never
// establishes inventory write/readback completion. Read the same complete
// journal domain as the executor; an empty envelope unresolvedIntents is not proof.
export async function verifyInventoryDryRun({plan, result, journalFile, commandId = '', journalFiles}) {
  assert(result?.execute === false && result.executionMode === 'dry_run', 'mode');
  assert((result.commandId || '') === commandId, 'command');
  assert(Array.isArray(plan?.actionable) && plan.executable === true && !plan.blockers?.length, 'plan');
  assert(!plan.commandId || plan.commandId === commandId, 'plan command');
  assert(result.policyVersion === plan.policyVersion, 'policy');
  const hashPayload = plan.schemaVersion === 'et-low-inventory-safety-plan/v1' ? {
    schemaVersion: plan.schemaVersion, date: plan.date, policyVersion: plan.policyVersion,
    actionable: plan.actionable, lowEtAllocations: plan.lowEtAllocations, etFactSource: plan.etFactSource,
    sourceEvidence: (plan.sourceEvidence || []).map(({ageHours, manifestAgeSeconds, endpointAgeSeconds, ...evidence}) => evidence),
    ...(plan.executionConstraints ? {executionConstraints: plan.executionConstraints} : {}),
  } : buildDailyInventoryPlanHashPayload(plan);
  assert(plan.payloadHash === stableInventoryHash(hashPayload)
    && result.planHash === plan.payloadHash, 'hash');
  assert(Array.isArray(result.results) && result.results.length === plan.actionable.length, 'coverage');
  assert(Array.isArray(result.unresolvedIntents) && result.unresolvedIntents.length === 0, 'unresolved');
  const expected = new Map(plan.actionable.map(row => [scope(row), row]));
  assert(expected.size === plan.actionable.length, 'duplicate plan row');
  const actual = new Set();
  for (const row of result.results) {
    const planRow = expected.get(scope(row));
    assert(planRow && !actual.has(scope(row)), 'missing/duplicate result row');
    actual.add(scope(row));
    assert(['storeKey', 'skc', 'skuCode'].every(key => typeof row[key] === 'string' && row[key])
      && Number.isSafeInteger(row.targetUsableInventory) && row.targetUsableInventory >= 0, 'invalid row');
    assert(['storeKey', 'skc', 'skuCode', 'targetUsableInventory', 'ruleClass'].every(key => row[key] === planRow[key]), 'row/target');
    assert(noWrite(row), 'write evidence');
    assert(['dry_run_ready', 'planned', 'pre_submit_blocked'].includes(row.state), 'row state');
  }
  const files = journalFiles || await discoverInventoryJournalFiles(journalFile, {
    includeAll: true,
    additionalDirectories: String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '').split(path.delimiter).filter(Boolean),
  });
  assert(files.map(file => path.resolve(file)).includes(path.resolve(journalFile)), 'current journal missing');
  const journalBytes = new Map();
  const entries = [];
  for (const file of files) {
    const stat = await fs.lstat(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), 'journal is not a regular file');
    const raw = await fs.readFile(file, 'utf8');
    journalBytes.set(file, raw);
    entries.push(...raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)));
  }
  const lifecycle = await readInventoryIntentJournals(files, {
    maxRunDate: plan.date, allowMultiplePendingByScope: true, currentJournalFile: journalFile,
    quarantineHistoricalDanglingSupersedes: true,
  });
  for (const [file, raw] of journalBytes) assert(await fs.readFile(file, 'utf8') === raw, 'journal changed');
  assert(![...lifecycle.intents.values()].some(intent => intent.planHash === plan.payloadHash
    || (commandId && intent.commandId === commandId)), 'related intent');
  assert(![...lifecycle.pending.values()].some(intent => expected.has(scope(intent))), 'pending scope');
  // Reject contradictory same-plan records too, including an uncertain POST
  // result without a surviving intent. Exact durable results must be present.
  for (const entry of entries.filter(entry => entry.kind === 'result' && entry.planHash === plan.payloadHash)) {
    assert(entry.row && noWrite(entry.row) && ['dry_run_ready', 'planned', 'pre_submit_blocked'].includes(entry.row.state), 'journal write/blocked result');
  }
  let excluded = 0;
  for (const row of result.results) {
    assert(entries.some(entry => entry.kind === 'result' && entry.planHash === plan.payloadHash
      && stableInventoryHash(entry.row) === stableInventoryHash(row)), 'durable result mismatch');
    if (row.state === 'pre_submit_blocked') {
      assert(isInventoryPreSubmitExclusion({row, planRow: expected.get(scope(row)), planHash: plan.payloadHash,
        commandId, lifecycle, entries}), 'unproven exclusion');
      excluded++;
    }
  }
  if (!journalFiles) {
    const fresh = await discoverInventoryJournalFiles(journalFile, {includeAll: true,
      additionalDirectories: String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '').split(path.delimiter).filter(Boolean)});
    assert(JSON.stringify([...fresh].sort()) === JSON.stringify([...files].sort()), 'journal domain changed');
  }
  return {status: 'dry_run_ready', state: 'dry_run_completed', total: result.results.length,
    ready: result.results.length - excluded, excluded, blocked: 0, inventoryPostAttempted: false};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [planFile, resultFile, commandId = ''] = process.argv.slice(2);
  const plan = JSON.parse(await fs.readFile(planFile, 'utf8'));
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  console.log(JSON.stringify(await verifyInventoryDryRun({plan, result, commandId, journalFile: resultFile + '.journal.ndjson'})));
}
