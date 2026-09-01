#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  appendDurableJournalRecord,
  discoverInventoryJournalFiles,
  INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
  inventoryIntentScopeKey,
  inventoryScopeFromIntent,
  readInventoryIntentJournals,
} from '../../lib/durable_inventory_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MS_PER_DAY = 86_400_000;

function parseArgs(argv) {
  const args = {journal: '', journalDir: [], store: '', skc: '', sku: '', intentId: '', oldRunDate: '', newRunDate: '', freshUsable: null, freshStore: '', freshSkc: '', freshSku: '', freshInvType: '', ownerConfirmationText: '', execute: false};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--journal') args.journal = path.resolve(argv[++i] || '');
    else if (a === '--journal-dir') args.journalDir.push(path.resolve(argv[++i] || ''));
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--skc') args.skc = String(argv[++i] || '').trim();
    else if (a === '--sku') args.sku = String(argv[++i] || '').trim();
    else if (a === '--intent-id') args.intentId = String(argv[++i] || '').trim();
    else if (a === '--old-run-date') args.oldRunDate = String(argv[++i] || '').trim();
    else if (a === '--new-run-date') args.newRunDate = String(argv[++i] || '').trim();
    else if (a === '--fresh-usable') args.freshUsable = Number(argv[++i]);
    else if (a === '--fresh-store') args.freshStore = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--fresh-skc') args.freshSkc = String(argv[++i] || '').trim();
    else if (a === '--fresh-sku') args.freshSku = String(argv[++i] || '').trim();
    else if (a === '--fresh-inv-type') args.freshInvType = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--owner-confirmation-text') args.ownerConfirmationText = String(argv[++i] || '').trim();
    else if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else throw new Error('Unknown argument: ' + a);
  }
  if (!args.journal) throw new Error('--journal is required');
  if (!args.store || !args.skc || !args.sku) throw new Error('--store, --skc and --sku are required');
  if (!args.intentId) throw new Error('--intent-id is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.oldRunDate)) throw new Error('--old-run-date must be YYYY-MM-DD');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.newRunDate)) throw new Error('--new-run-date must be YYYY-MM-DD');
  if (!Number.isSafeInteger(args.freshUsable) || args.freshUsable < 0 || args.freshUsable >= 10) throw new Error('--fresh-usable must be an integer below 10');
  if (!args.freshStore || !args.freshSkc || !args.freshSku || args.freshInvType !== 'VI') throw new Error('--fresh-store, --fresh-skc, --fresh-sku and --fresh-inv-type VI are required');
  if (args.ownerConfirmationText !== '补到10') throw new Error('--owner-confirmation-text must exactly equal 补到10');
  return args;
}

function daysBetween(oldDate, newDate) {
  const oldMs = Date.parse(oldDate + 'T00:00:00Z');
  const newMs = Date.parse(newDate + 'T00:00:00Z');
  if (!Number.isFinite(oldMs) || !Number.isFinite(newMs)) return NaN;
  return Math.floor((newMs - oldMs) / MS_PER_DAY);
}

function fail(code, message, extra = {}) {
  const error = new Error(code + ':' + message);
  error.code = code;
  Object.assign(error, extra);
  throw error;
}

const args = parseArgs(process.argv.slice(2));
const journalFile = path.resolve(args.journal);
const journalFiles = await discoverInventoryJournalFiles(journalFile, {includeAll: true, additionalDirectories: args.journalDir});
const bundle = await readInventoryIntentJournals(journalFiles, {maxRunDate: args.newRunDate, allowMultiplePendingByScope: true});
const scopeKey = inventoryIntentScopeKey({storeKey: args.store, skc: args.skc, skuCode: args.sku});
const matchingPending = (bundle.pendingByScope.get(scopeKey) || [])
  .filter(intent => String(intent.storeKey || '').toUpperCase() === args.store)
  .filter(intent => String(intent.skc || '') === args.skc)
  .filter(intent => String(intent.skuCode || '') === args.sku);

if (matchingPending.length !== 1) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SCOPE_INVALID', 'pending_count=' + matchingPending.length, {pendingCount: matchingPending.length});
const [intent] = matchingPending;
if (intent.intentId !== args.intentId) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_INTENT_INVALID', 'intent_id_mismatch');
if (intent.runDate !== args.oldRunDate) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_RUN_DATE_INVALID', 'old_run_date_mismatch');
const intentScope = inventoryScopeFromIntent(intent);
if (intentScope.invType !== 'VI') fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_IDENTITY_DRIFT', 'invType');
if (intentScope.storeKey !== args.store || intentScope.skc !== args.skc || intentScope.skuCode !== args.sku) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_IDENTITY_DRIFT', 'store_skc_sku');
if (args.freshStore !== args.store || args.freshSkc !== args.skc || args.freshSku !== args.sku || args.freshInvType !== intentScope.invType) {
  fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_IDENTITY_DRIFT', 'fresh_store_skc_sku_invType');
}
if (Number(intent.targetUsableInventory) !== 10) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_TARGET_INVALID', 'old_target_not_10');
const ageDays = daysBetween(intent.runDate, args.newRunDate);
if (!Number.isSafeInteger(ageDays) || ageDays < 14) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_AGE_INVALID', 'ageDays=' + ageDays);
if (intent.runDate >= args.newRunDate) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_AGE_INVALID', 'old_runDate_not_before_new_runDate');
const intentKey = path.resolve(intent.journalFile) + '\u0000' + intent.intentId;
if (bundle.terminalOutcomes.has(intentKey)) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_LIFECYCLE_INVALID', 'intent_already_terminal');
if (bundle.manualResolutions.has(intentKey)) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_LIFECYCLE_INVALID', 'intent_already_manually_resolved');

const outcome = {
  kind: 'write_outcome',
  intentId: intent.intentId,
  logicalActionKey: intent.logicalActionKey,
  disposition: INVENTORY_OWNER_CONFIRMED_SAME_TARGET_SUPERSEDE_DISPOSITION,
  oldRunDate: intent.runDate,
  newRunDate: args.newRunDate,
  targetUsableInventory: 10,
  freshUsableInventory: args.freshUsable,
  originalEffectUnknown: true,
  ownerConfirmationText: args.ownerConfirmationText,
  recordedAt: new Date().toISOString(),
};

if (args.execute) {
  await appendDurableJournalRecord(intent.journalFile, outcome);
  const after = await readInventoryIntentJournals(journalFiles, {maxRunDate: args.newRunDate, allowMultiplePendingByScope: true});
  if (after.pending.has(intentKey)) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_READBACK_FAILED', 'old_intent_still_pending');
  if (!after.tombstonedIdempotencyKeys.has(intent.idempotencyKey)) fail('INVENTORY_OWNER_CONFIRMED_SAME_TARGET_READBACK_FAILED', 'old_idempotency_not_tombstoned');
}

console.log(JSON.stringify({
  ok: true,
  dryRun: !args.execute,
  disposition: outcome.disposition,
  originalEffectUnknown: outcome.originalEffectUnknown,
  oldIntentId: intent.intentId,
  oldRunDate: intent.runDate,
  newRunDate: args.newRunDate,
  storeKey: intent.storeKey,
  skc: intent.skc,
  skuCode: intent.skuCode,
  targetUsableInventory: 10,
  freshUsableInventory: args.freshUsable,
  oldIdempotencyKey: intent.idempotencyKey,
  journalFile: path.relative(ROOT, intent.journalFile).replaceAll(path.sep, '/'),
  event: outcome,
}, null, 2));
