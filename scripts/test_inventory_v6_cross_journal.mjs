#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {
  computeInventoryOverwriteQuantity, INVENTORY_OVERWRITE_COMPUTATION_VERSION, stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';
import {
  appendDurableJournalRecord, appendInventoryReconciliationRecord, discoverInventoryJournalFiles,
  inventoryIntentHash, inventoryLogicalActionKey, inventoryRecoveryScopeKey,
  readInventoryIntentJournals, readInventoryIntentLifecycle,
} from '../lib/durable_inventory_write.mjs';
import {acquireCrossProcessTicketLock} from '../lib/cross_process_ticket_lock.mjs';
import {
  fileSha256AndBytes, publishDailyInventoryResultVersion, readDailyInventoryVersionIndex,
  resolveInventoryVersionIndexPath,
} from './inventory/daily_inventory_version_publisher.mjs';

const execFileAsync = promisify(execFile);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-v6-cross-journal-'));
const runtime = path.join(temp, 'runtime');
const date = '2026-09-04';
const businessDate = '2026-09-03';
const scope = {storeKey: 'DL', skc: 'CROSS-中文-SKC', skuCode: 'CROSS-中文-SKU'};
const policyVersion = '2026-08-12.2';
const authorizationId = 'owner-automatic-inventory-20260803-v1';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const crlf = value => Buffer.from(JSON.stringify(value, null, 2).replaceAll('\n', '\r\n') + '\r\n');
let checks = 0;
async function check(name, fn) {
  try { await fn(); checks += 1; }
  catch (error) { error.message = name + ': ' + error.message; throw error; }
}

// Reuse the complete strict fixture contract from
// test_inventory_journal_discovery_domain.mjs: exact request shape, immutable
// hashes, overwrite profile, before quantities, authorization, and chronology.
// The V6 logical key additionally binds commandId through the actual helper.
function makeIntent(commandId) {
  const targetUsableInventory = 10;
  const before = {totalInventoryQuantity: 2, totalUsableInventory: 2, totalLockedQuantity: 0,
    temporaryInventoryQuantity: 0, stockRowMissing: false};
  const logicalActionKey = inventoryLogicalActionKey({commandId, runDate: date, ...scope,
    targetUsableInventory, policyVersion, authorizationId});
  const request = {
    pathname: '/open-api/stock/change-inventory/v2', method: 'POST',
    body: {updateSkuInventoryQuantityRequests: [{
      idempotencyKey: `bi-inv-${logicalActionKey.slice(0, 42)}`, skuCode: scope.skuCode,
      invType: 'VI', changeType: 'OVERWRITE',
      changeQuantity: computeInventoryOverwriteQuantity(targetUsableInventory, before),
      changeReason: 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard',
    }]}, headers: {language: 'en'},
  };
  return {
    kind: 'intent', intentId: 'intent-' + commandId, commandId, logicalActionKey,
    recoveryScopeKey: inventoryRecoveryScopeKey({runDate: date, ...scope}),
    planHash: stableInventoryHash({commandId, date, ...scope, targetUsableInventory}),
    runDate: date, ...scope, targetUsableInventory, policyVersion,
    overwriteComputationVersion: INVENTORY_OVERWRITE_COMPUTATION_VERSION, authorizationId,
    idempotencyKey: request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,
    requestPayloadHash: stableInventoryHash(request), request, before,
    recordedAt: date + 'T01:00:00.000Z',
  };
}
const readback = intent => ({kind: 'write_outcome', intentId: intent.intentId,
  logicalActionKey: intent.logicalActionKey, disposition: 'readback_matched', recordedAt: date + 'T01:01:00.000Z'});
const keyOf = (journal, intent) => path.resolve(journal) + '\u0000' + intent.intentId;

async function tuple(commandId, {intent = null, state = 'submitted_but_readback_pending', inventoryRuntimeRoot = runtime} = {}) {
  const directory = path.join(inventoryRuntimeRoot, 'runs', date, sha(commandId).slice(0, 40));
  const options = {
    inventoryRuntimeRoot, root: temp, date, batchId: 'batch-' + commandId, commandId,
    stagingPlanFile: path.join(directory, 'plans', 'daily-inventory-replenishment-' + date + '.json'),
    stagingResultFile: path.join(directory, 'results', 'v6-newprefix-' + date + '.json'),
    stagingJournalFile: path.join(directory, 'results', 'v6-newprefix-' + date + '.json.journal.ndjson'),
    stagingMarkerFile: path.join(directory, 'markers', date, 'daily-inventory-guard.json'),
  };
  for (const file of [options.stagingPlanFile, options.stagingResultFile, options.stagingMarkerFile]) {
    await fs.mkdir(path.dirname(file), {recursive: true});
  }
  const row = {...scope, targetUsableInventory: 10};
  const plan = {date, commandId, payloadHash: intent?.planHash || stableInventoryHash({commandId, row}), actionable: [row]};
  const result = {planHash: plan.payloadHash, execute: true, executionMode: 'automatic',
    generatedAt: date + 'T01:02:00.000Z', results: [{...row, state}]};
  await fs.writeFile(options.stagingPlanFile, crlf(plan));
  await fs.writeFile(options.stagingResultFile, crlf(result));
  await fs.writeFile(options.stagingJournalFile, intent ? Buffer.from(JSON.stringify(intent) + '\r\n') : Buffer.alloc(0));
  const marker = {stage: 'daily-inventory-guard', runDate: date, businessDate, ok: true,
    status: state === 'submitted_but_readback_pending' ? 'warning' : 'done',
    evidence: await Promise.all([options.stagingPlanFile, options.stagingResultFile].map(async file => ({
      path: path.resolve(file), ...await fileSha256AndBytes(file),
    }))),
  };
  await fs.writeFile(options.stagingMarkerFile, crlf(marker));
  return options;
}

async function savedBytes(entry, inventoryRuntimeRoot) {
  const saved = new Map();
  assert.deepEqual(Object.keys(entry.artifacts).sort(), ['journal', 'marker', 'plan', 'result']);
  for (const artifact of Object.values(entry.artifacts)) {
    const original = await fs.readFile(artifact.file);
    const snapshot = path.resolve(inventoryRuntimeRoot, artifact.snapshot);
    assert.deepEqual(await fs.readFile(snapshot), original);
    assert.equal(sha(original), artifact.sha256);
    assert.equal(original.length, artifact.bytes);
    saved.set(artifact.file, original);
    saved.set(snapshot, original);
  }
  const sealFile = entry.artifacts.journal.file + '.sealed.json';
  const sealBytes = await fs.readFile(sealFile);
  assert.deepEqual(JSON.parse(sealBytes), {schemaVersion: 'inventory-journal-seal/v1',
    sha256: entry.artifacts.journal.sha256, bytes: entry.artifacts.journal.bytes});
  saved.set(sealFile, sealBytes);
  return saved;
}
async function unchanged(saved) {
  for (const [file, bytes] of saved) assert.deepEqual(await fs.readFile(file), bytes, file + ' changed');
}

try {
  const intent = makeIntent('old-command');
  const first = await tuple('old-command', {intent});
  const oldJournal = first.stagingJournalFile;
  const oldRaw = await fs.readFile(oldJournal);
  await check('complete fixture passes strict immutable intent validation', async () => {
    const lifecycle = await readInventoryIntentLifecycle(oldJournal, {strict: true, maxRunDate: date});
    assert.deepEqual(lifecycle.intents.get(intent.intentId), intent);
    assert.equal(lifecycle.pending.size, 1);
    assert.equal(lifecycle.terminalOutcomes.size, 0);
    const malformed = path.join(temp, 'invalid-intent.journal.ndjson');
    await fs.writeFile(malformed, JSON.stringify({...intent, requestPayloadHash: '0'.repeat(64)}) + '\n');
    await assert.rejects(readInventoryIntentLifecycle(malformed, {strict: true}), /INVENTORY_JOURNAL_IMMUTABLE_INVALID:.*requestPayloadHash/);
  });
  let oldSaved;
  await check('real publication seals a CRLF Chinese journal without rewriting it', async () => {
    const entry = await publishDailyInventoryResultVersion(first);
    assert.equal(entry.status, 'warning');
    assert.equal(entry.version, 1);
    oldSaved = await savedBytes(entry, runtime);
    assert.deepEqual(await fs.readFile(oldJournal), oldRaw);
    await assert.rejects(appendDurableJournalRecord(oldJournal, readback(intent)), /INVENTORY_JOURNAL_SEALED/);
    await unchanged(oldSaved);
  });
  const second = await tuple('new-command', {state: 'skipped_terminal_readback_recorded'});
  const newJournal = second.stagingJournalFile;
  let reference;
  await check('actual reconciliation helper binds the old journal and strict intent', async () => {
    const original = (await readInventoryIntentJournals([oldJournal], {maxRunDate: date})).pending.get(keyOf(oldJournal, intent));
    assert.ok(original);
    await appendInventoryReconciliationRecord(newJournal, original, readback(intent));
    reference = JSON.parse(await fs.readFile(newJournal, 'utf8'));
    assert.deepEqual(reference, {kind: 'cross_journal_resolution', schemaVersion: 'inventory-cross-journal-resolution/v1',
      sourceJournal: path.resolve(oldJournal), sourceSha256: sha(oldRaw), intentHash: inventoryIntentHash(intent), event: readback(intent)});
    await unchanged(oldSaved);
    await assert.rejects(readInventoryIntentLifecycle(newJournal, {strict: true}), /INVENTORY_JOURNAL_CROSS_REFERENCE_REQUIRES_AGGREGATE/);
  });
  await check('newprefix runs discovery resolves old intent once, regardless of file order', async () => {
    const discovered = await discoverInventoryJournalFiles(newJournal, {includeAll: true});
    assert.deepEqual(new Set(discovered), new Set([newJournal, oldJournal]));
    for (const files of [discovered, [...discovered].reverse()]) {
      const bundle = await readInventoryIntentJournals(files, {maxRunDate: date});
      assert.equal(bundle.intents.size, 1);
      assert.equal(bundle.pending.size, 0);
      assert.equal(bundle.terminalOutcomes.size, 1);
      assert.equal([...bundle.pendingByScope.values()].flat().length, 0);
      assert.deepEqual(bundle.terminalOutcomes.get(keyOf(oldJournal, intent)), {
        ...readback(intent), journalFile: oldJournal, resolutionJournalFile: newJournal,
      });
      const sourceRecord = bundle.records.find(record => record.journalFile === oldJournal);
      assert.equal(sourceRecord.pending.size, 0);
      assert.equal(sourceRecord.terminalOutcomes.get(intent.intentId).disposition, 'readback_matched');
    }
    const alone = await readInventoryIntentLifecycle(oldJournal, {strict: true});
    assert.equal(alone.pending.size, 1, 'aggregation must not append a terminal event to the sealed source');
    await assert.rejects(readInventoryIntentJournals([newJournal], {maxRunDate: date}), /CROSS_REFERENCE_INVALID:intent binding/);
    await unchanged(oldSaved);
  });
  await check('same-day v2 publication and replay preserve both sealed versions', async () => {
    const entry = await publishDailyInventoryResultVersion(second);
    assert.equal(entry.version, 2);
    assert.equal(entry.status, 'done');
    const newSaved = await savedBytes(entry, runtime);
    const indexFile = resolveInventoryVersionIndexPath(runtime, date);
    const indexBytes = await fs.readFile(indexFile);
    const index = await readDailyInventoryVersionIndex({inventoryRuntimeRoot: runtime, date});
    assert.deepEqual(index.batches.map(row => row.commandId), ['old-command', 'new-command']);
    assert.equal(index.activeVersion, 2);
    const frozenLifecycle = batch => readInventoryIntentJournals(batch.journalArtifacts.map(row => row.file), {
      maxRunDate: date,
      journalSnapshots: new Map(batch.journalArtifacts.map(row => [row.file, path.resolve(runtime, row.snapshot)])),
    });
    const oldView = await frozenLifecycle(index.batches[0]);
    assert.equal(oldView.pending.size, 1, 'old published warning keeps its original journal view after new readback');
    assert.equal(oldView.terminalOutcomes.size, 0);
    const newView = await frozenLifecycle(index.batches[1]);
    assert.equal(newView.pending.size, 0);
    assert.equal(newView.terminalOutcomes.size, 1);
    const futureJournal = path.join(path.dirname(newJournal), 'daily-inventory-replenishment-2026-09-05.json.journal.ndjson');
    await fs.writeFile(futureJournal, '\n');
    try {
      await assert.rejects(readInventoryIntentJournals(await discoverInventoryJournalFiles(newJournal, {includeAll: true}), {maxRunDate: date}), /INVENTORY_JOURNAL_FUTURE_DATE/);
      assert.equal((await frozenLifecycle(index.batches[0])).pending.size, 1, 'later-day files cannot invalidate archived readers');
    } finally { await fs.unlink(futureJournal); }
    assert.equal((await publishDailyInventoryResultVersion(second)).version, 2);
    assert.deepEqual(await fs.readFile(indexFile), indexBytes);
    await assert.rejects(appendInventoryReconciliationRecord(newJournal, {...intent, journalFile: oldJournal}, readback(intent)), /INVENTORY_JOURNAL_SEALED/);
    await unchanged(oldSaved);
    await unchanged(newSaved);
  });

  const twin = path.join(temp, 'same-hash-source.journal.ndjson');
  await fs.writeFile(twin, oldRaw);
  assert.deepEqual(await fileSha256AndBytes(twin), await fileSha256AndBytes(oldJournal));
  for (const candidate of [
    {name: 'source path with identical bytes', mutate: r => { r.sourceJournal = twin; }, error: /CROSS_REFERENCE_INVALID:intent binding/},
    {name: 'source hash', mutate: r => { r.sourceSha256 = '0'.repeat(64); }, error: /CROSS_REFERENCE_INVALID:source bytes changed/},
    {name: 'intent hash', mutate: r => { r.intentHash = '0'.repeat(64); }, error: /CROSS_REFERENCE_INVALID:intent binding/},
    {name: 'orphan intent', mutate: r => { r.event.intentId = 'absent-intent'; }, error: /CROSS_REFERENCE_INVALID:intent binding/},
    {name: 'logical key', mutate: r => { r.event.logicalActionKey = '0'.repeat(64); }, error: /INVENTORY_JOURNAL_OUTCOME_INVALID:.*logicalActionKey/},
    {name: 'timestamp order', mutate: r => { r.event.recordedAt = date + 'T00:59:00.000Z'; }, error: /INVENTORY_JOURNAL_OUTCOME_INVALID:.*recordedAtOrder/},
  ]) {
    await check('cross-journal rejects ' + candidate.name, async () => {
      const changed = structuredClone(reference);
      candidate.mutate(changed);
      const file = path.join(temp, 'negative-' + checks + '.journal.ndjson');
      await fs.writeFile(file, JSON.stringify(changed) + '\n');
      await assert.rejects(readInventoryIntentJournals([oldJournal, file], {maxRunDate: date}), candidate.error);
      await fs.writeFile(file, JSON.stringify(reference) + '\n');
      const repaired = await readInventoryIntentJournals([oldJournal, file], {maxRunDate: date});
      assert.equal(repaired.pending.size, 0);
      assert.equal(repaired.terminalOutcomes.size, 1);
      await unchanged(oldSaved);
    });
  }
  await check('duplicate cross-journal terminal events fail closed', async () => {
    const duplicate = path.join(temp, 'duplicate-resolution.journal.ndjson');
    await appendInventoryReconciliationRecord(duplicate, {...intent, journalFile: oldJournal}, readback(intent));
    await assert.rejects(readInventoryIntentJournals([oldJournal, newJournal, duplicate], {maxRunDate: date}), /CROSS_REFERENCE_INVALID:duplicate resolution/);
    await unchanged(oldSaved);
  });

  // Independent Node processes, no shell or business executor. Holding the
  // actual lock lets us observe both FIFO tickets before releasing either one.
  for (const appendFirst of [false, true]) {
    await check('publication lock serializes ' + (appendFirst ? 'append then seal' : 'seal then rejected append'), async () => {
      const command = appendFirst ? 'append-first' : 'publish-first';
      const lockIntent = makeIntent(command);
      const options = await tuple(command, {intent: lockIntent, state: 'skipped_terminal_readback_recorded',
        inventoryRuntimeRoot: path.join(temp, command)});
      const journal = options.stagingJournalFile;
      const before = await fs.readFile(journal);
      const release = await acquireCrossProcessTicketLock(journal + '.publication.lock');
      const children = [];
      let failure;
      const publisherUrl = new URL('./inventory/daily_inventory_version_publisher.mjs', import.meta.url).href;
      const durableUrl = new URL('../lib/durable_inventory_write.mjs', import.meta.url).href;
      const code = {
        publish: `import {publishDailyInventoryResultVersion as publish} from ${JSON.stringify(publisherUrl)};
          await publish(${JSON.stringify(options)}); console.log('published');`,
        append: `import {appendDurableJournalRecord as append} from ${JSON.stringify(durableUrl)};
          try { await append(${JSON.stringify(journal)}, ${JSON.stringify(readback(lockIntent))}); console.log('appended'); }
          catch (error) { if (!error.message.startsWith('INVENTORY_JOURNAL_SEALED:')) throw error; console.log('sealed'); }`,
      };
      const waitTickets = async count => {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          if ((await fs.readdir(journal + '.publication.lock.tickets')).filter(name => name.endsWith('.json')).length === count) return;
          await delay(25);
        }
        assert.fail('expected ' + count + ' actual publication lock tickets');
      };
      const order = appendFirst ? ['append', 'publish'] : ['publish', 'append'];
      try {
        for (const operation of order) {
          children.push(execFileAsync(process.execPath, ['--input-type=module', '-e', code[operation]], {timeout: 15_000})
            .then(value => ({operation, value}), error => ({operation, error})));
          await waitTickets(children.length + 1);
        }
        assert.deepEqual(await fs.readFile(journal), before);
        await assert.rejects(fs.access(journal + '.sealed.json'), {code: 'ENOENT'});
        await assert.rejects(fs.access(resolveInventoryVersionIndexPath(options.inventoryRuntimeRoot, date)), {code: 'ENOENT'});
      } catch (error) { failure = error; }
      finally { await release(); }
      const completed = await Promise.all(children);
      if (failure) throw failure;
      for (const child of completed) {
        if (child.error) throw child.error;
        assert.equal(child.value.stderr, '');
        assert.equal(child.value.stdout.trim(), child.operation === 'publish' ? 'published' : appendFirst ? 'appended' : 'sealed');
      }
      const expected = appendFirst ? Buffer.concat([before, Buffer.from(JSON.stringify(readback(lockIntent)) + '\n')]) : before;
      assert.deepEqual(await fs.readFile(journal), expected);
      const index = await readDailyInventoryVersionIndex({inventoryRuntimeRoot: options.inventoryRuntimeRoot, date});
      assert.equal(index.batches.length, 1);
      assert.equal(index.batches[0].artifacts.journal.sha256, sha(expected));
      const saved = await savedBytes(index.batches[0], options.inventoryRuntimeRoot);
      await assert.rejects(appendDurableJournalRecord(journal, readback(lockIntent)), /INVENTORY_JOURNAL_SEALED/);
      await unchanged(saved);
      assert.deepEqual(await fs.readdir(journal + '.publication.lock.tickets'), []);
    });
  }
} finally {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(temp));
  assert.ok(relative.startsWith('inventory-v6-cross-journal-') && !relative.includes(path.sep));
  await fs.rm(temp, {recursive: true, force: true});
  await assert.rejects(fs.access(temp), {code: 'ENOENT'});
}
console.log(JSON.stringify({ok: true, checks, cleaned: true}));
