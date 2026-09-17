#!/usr/bin/env node
// Regression fixture taken verbatim from production on 2026-09-17: one abandoned
// 2026-09-03 intent was closed by TWO different journals (the 09-15 morning chain
// and the 09-16 ET low-inventory guard), and the strict aggregate reader treated
// the redundant second closure as a fatal conflict. Every later inventory run
// failed closed with INVENTORY_JOURNAL_CROSS_REFERENCE_INVALID:duplicate
// resolution, so the whole day's inventory plan was never even written.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  appendInventoryReconciliationRecord,
  crossJournalClosureHash,
  findInventoryIntentClosures,
  inventoryIntentHash,
  readInventoryIntentJournals,
} from '../lib/durable_inventory_write.mjs';

// line 77 of /srv/shein-bi/runtime/daily-inventory-replenishment/results/daily-inventory-replenishment-2026-09-03.json.journal.ndjson
const REAL_INTENT_ENTRY = {"kind":"intent","intentId":"bad0e90e-f211-4dbc-b9bd-968b047c23dd","logicalActionKey":"82de520e009e85b16d51816a01e27a15542be1789876c45cdf4b840fb5cedb40","recoveryScopeKey":"fdcad510edcae8a78a49cb11609c8c7ebfb1b2153b9114cb72c026269d88a502","planHash":"29b1eaea1bd3c54bbfc173df7fe675e7a6e0ac931de5740acf2bb2ad3d098625","runDate":"2026-09-03","storeKey":"XL","skc":"sv260102130015778541580","skuCode":"I9mjweo3tyo2c3","targetUsableInventory":2,"policyVersion":"2026-08-23.1","overwriteComputationVersion":"locked-only/v1","authorizationId":"owner-automatic-inventory-20260803-v1","idempotencyKey":"bi-inv-82de520e009e85b16d51816a01e27a15542be17898","requestPayloadHash":"692475ebb707f85ff54d965c8d0a0d9ca0ba442e54120d1ecc736cb1e4dc0739","request":{"pathname":"/open-api/stock/change-inventory/v2","method":"POST","body":{"updateSkuInventoryQuantityRequests":[{"idempotencyKey":"bi-inv-82de520e009e85b16d51816a01e27a15542be17898","skuCode":"I9mjweo3tyo2c3","invType":"VI","changeType":"OVERWRITE","changeQuantity":2,"changeReason":"Owner-authorized daily inventory target after current-day ET and sales/exposure guard"}]},"headers":{"language":"en"}},"before":{"ok":true,"skuCode":"I9mjweo3tyo2c3","totalInventoryQuantity":2,"totalUsableInventory":1,"totalLockedQuantity":0,"stockRowMissing":false,"warehouseCodes":["PS0916742261"]},"recordedAt":"2026-09-03T00:37:10.216Z"};

// line 85 of runs/2026-09-15/9fe3e05ab5e3ac9bde4fa7c543a5328daf7112b7ab87712ecb46497c4aa18ffb/results/daily-inventory-replenishment-2026-09-15.json.journal.ndjson
const REAL_CLOSURE_MORNING = {"kind":"cross_journal_resolution","schemaVersion":"inventory-cross-journal-resolution/v1","sourceJournal":"/srv/shein-bi/runtime/daily-inventory-replenishment/results/daily-inventory-replenishment-2026-09-03.json.journal.ndjson","sourceSha256":"8815a47c77f354447a3df42529cc5b10a7e220fc9e0465312dabfe9e6070b3e4","intentHash":"7f078bec0400ef2bae2f4c5e98fe12ab7ccdd53419f5a957a741b0e899d41876","event":{"kind":"write_outcome","intentId":"bad0e90e-f211-4dbc-b9bd-968b047c23dd","logicalActionKey":"82de520e009e85b16d51816a01e27a15542be1789876c45cdf4b840fb5cedb40","disposition":"superseded_by_later_plan","originalEffectUnknown":true,"oldRunDate":"2026-09-03","newRunDate":"2026-09-15","supersedeRule":"stale-pending-intent-superseded-by-later-daily-plan/v1","recordedAt":"2026-09-15T00:54:29.271Z"}};

// line 3 of /srv/shein-bi/runtime/et-low-inventory-guard/results/et-low-inventory-et-daily-2026-09-16-2026-09-16T10-20-03-322Z.json.journal.ndjson
const REAL_CLOSURE_ET_GUARD = {"kind":"cross_journal_resolution","schemaVersion":"inventory-cross-journal-resolution/v1","sourceJournal":"/srv/shein-bi/runtime/daily-inventory-replenishment/results/daily-inventory-replenishment-2026-09-03.json.journal.ndjson","sourceSha256":"8815a47c77f354447a3df42529cc5b10a7e220fc9e0465312dabfe9e6070b3e4","intentHash":"7f078bec0400ef2bae2f4c5e98fe12ab7ccdd53419f5a957a741b0e899d41876","event":{"kind":"write_outcome","intentId":"bad0e90e-f211-4dbc-b9bd-968b047c23dd","logicalActionKey":"82de520e009e85b16d51816a01e27a15542be1789876c45cdf4b840fb5cedb40","disposition":"superseded_by_later_plan","originalEffectUnknown":true,"oldRunDate":"2026-09-03","newRunDate":"2026-09-16","supersedeRule":"stale-pending-intent-superseded-by-later-daily-plan/v1","recordedAt":"2026-09-16T10:23:15.781Z"}};

// The two rows differ only in when the supersede was recorded and which run
// superseded: every other field, including the closure identity, is identical.
const REAL_SOURCE_SHA256 = '8815a47c77f354447a3df42529cc5b10a7e220fc9e0465312dabfe9e6070b3e4';
const REAL_INTENT_HASH = '7f078bec0400ef2bae2f4c5e98fe12ab7ccdd53419f5a957a741b0e899d41876';
const MAX_RUN_DATE = '2026-09-16';

assert.equal(inventoryIntentHash(REAL_INTENT_ENTRY), REAL_INTENT_HASH,
  'the embedded intent line must be the exact production row');
assert.equal(REAL_CLOSURE_MORNING.sourceSha256, REAL_SOURCE_SHA256,
  'the embedded 09-15 closure must be the exact production row');
assert.equal(REAL_CLOSURE_ET_GUARD.sourceSha256, REAL_SOURCE_SHA256,
  'the embedded 09-16 closure must be the exact production row');
assert.equal(crossJournalClosureHash(REAL_CLOSURE_MORNING), crossJournalClosureHash(REAL_CLOSURE_ET_GUARD),
  'the two production closures are the same closure recorded twice');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-cross-journal-duplicate-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

async function writeLines(file, entries) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');
  return file;
}

async function closureFixture(name, {first, second = null} = {}) {
  const dir = path.join(temp, name);
  const sourceJournal = await writeLines(
    path.join(dir, 'results', 'daily-inventory-replenishment-2026-09-03.json.journal.ndjson'),
    [REAL_INTENT_ENTRY],
  );
  // The fixture source holds only the intent row, so the recorded source path and
  // hash are re-pointed at it; the real production values stay asserted above and
  // every other field of the two rows is verbatim production data.
  const sourceSha256 = crypto.createHash('sha256').update(await fs.readFile(sourceJournal)).digest('hex');
  const rehash = entry => ({...entry, sourceJournal, sourceSha256});
  const firstJournal = await writeLines(
    path.join(dir, 'runs', '2026-09-15', '9fe3e05ab5e3ac9bde4fa7c543a5328daf7112b7ab87712ecb46497c4aa18ffb', 'results', 'daily-inventory-replenishment-2026-09-15.json.journal.ndjson'),
    [rehash(first)],
  );
  const secondJournal = second
    ? await writeLines(
      path.join(dir, 'et-low-inventory-guard', 'results', 'et-low-inventory-et-daily-2026-09-16-2026-09-16T10-20-03-322Z.json.journal.ndjson'),
      [rehash(second)],
    )
    : '';
  return {dir, sourceJournal, firstJournal, secondJournal, sourceSha256, first: rehash(first), second: second ? rehash(second) : null};
}

try {
  await (async () => {
    const order = [['morning first', ['first', 'second']], ['ET guard first', ['second', 'first']]];
    for (const [label, [a, b]] of order) {
      const fixture = await closureFixture('order-' + label.replace(/\s+/g, '-'), {
        first: REAL_CLOSURE_MORNING,
        second: REAL_CLOSURE_ET_GUARD,
      });
      const byName = {first: fixture.firstJournal, second: fixture.secondJournal};
      const files = [fixture.sourceJournal, byName[a], byName[b]];
      const bundle = await readInventoryIntentJournals(files, {
        maxRunDate: MAX_RUN_DATE,
        allowMultiplePendingByScope: true,
        currentJournalFile: fixture.sourceJournal,
        quarantineHistoricalDanglingSupersedes: true,
      });
      assert.equal(bundle.pending.size, 0, label + ': the intent must not stay pending');
      assert.equal(bundle.terminalOutcomes.size, 1, label + ': the intent must terminate exactly once');
      const applied = [...bundle.terminalOutcomes.values()][0];
      assert.equal(applied.disposition, 'superseded_by_later_plan', label + ': first closure wins');
      assert.equal(applied.newRunDate, a === 'first' ? '2026-09-15' : '2026-09-16',
        label + ': the applied closure follows the file order');
      assert.equal(bundle.duplicateCrossJournalResolutions.length, 1, label + ': the repeat is reported once');
      const duplicate = bundle.duplicateCrossJournalResolutions[0];
      assert.equal(duplicate.intentId, REAL_INTENT_ENTRY.intentId);
      assert.equal(duplicate.firstJournalFile, byName[a], label + ': first row is named');
      assert.equal(duplicate.duplicateJournalFile, byName[b], label + ': duplicate row is named');
      assert.equal(duplicate.firstLineNumber, 1);
      assert.equal(duplicate.duplicateLineNumber, 1);
      assert.equal(duplicate.closureHash, crossJournalClosureHash(fixture.first));
      checks.push('production duplicate tolerated (' + label + ')');
    }

    const conflicting = await closureFixture('conflicting', {
      first: {kind: 'cross_journal_resolution', schemaVersion: 'inventory-cross-journal-resolution/v1',
        sourceJournal: REAL_CLOSURE_MORNING.sourceJournal, sourceSha256: REAL_CLOSURE_MORNING.sourceSha256,
        intentHash: REAL_CLOSURE_MORNING.intentHash,
        event: {kind: 'write_outcome', intentId: REAL_INTENT_ENTRY.intentId,
          logicalActionKey: REAL_INTENT_ENTRY.logicalActionKey, disposition: 'rejected',
          code: 'FIRST-REJECTION', httpOk: true, httpStatus: 200, success: false,
          recordedAt: '2026-09-16T10:23:15.781Z'}},
      second: {kind: 'cross_journal_resolution', schemaVersion: 'inventory-cross-journal-resolution/v1',
        sourceJournal: REAL_CLOSURE_ET_GUARD.sourceJournal, sourceSha256: REAL_CLOSURE_ET_GUARD.sourceSha256,
        intentHash: REAL_CLOSURE_ET_GUARD.intentHash,
        event: {kind: 'write_outcome', intentId: REAL_INTENT_ENTRY.intentId,
          logicalActionKey: REAL_INTENT_ENTRY.logicalActionKey, disposition: 'rejected',
          code: 'SECOND-REJECTION', httpOk: true, httpStatus: 200, success: false,
          recordedAt: '2026-09-16T10:24:15.781Z'}},
    });
    await assert.rejects(
      readInventoryIntentJournals([conflicting.sourceJournal, conflicting.firstJournal, conflicting.secondJournal], {
        maxRunDate: MAX_RUN_DATE, allowMultiplePendingByScope: true,
        currentJournalFile: conflicting.sourceJournal, quarantineHistoricalDanglingSupersedes: true,
      }),
      /CROSS_REFERENCE_INVALID:duplicate resolution/,
      'two closures that disagree on content must stay a hard conflict',
    );
    checks.push('conflicting duplicate still fails closed');

    const appendFixture = await closureFixture('append', {first: REAL_CLOSURE_MORNING, second: REAL_CLOSURE_ET_GUARD});
    const target = path.join(appendFixture.dir, 'et-low-inventory-guard', 'results', 'et-low-inventory-et-daily-2026-09-17-2026-09-16T18-20-03-322Z.json.journal.ndjson');
    const targetBytesBefore = Buffer.from(await fs.readFile(appendFixture.secondJournal));
    const candidateEvent = {kind: 'write_outcome', intentId: REAL_INTENT_ENTRY.intentId,
      logicalActionKey: REAL_INTENT_ENTRY.logicalActionKey, disposition: 'superseded_by_later_plan',
      originalEffectUnknown: true, oldRunDate: '2026-09-03', newRunDate: '2026-09-17',
      supersedeRule: 'stale-pending-intent-superseded-by-later-daily-plan/v1',
      recordedAt: '2026-09-17T02:20:03.000Z'};
    const skipped = await appendInventoryReconciliationRecord(
      target,
      {...REAL_INTENT_ENTRY, journalFile: appendFixture.sourceJournal},
      candidateEvent,
      // The managed domain defaults are the production absolute paths; the
      // fixture declares its own run-scoped tree instead.
      {additionalDirectories: [path.join(appendFixture.dir, 'runs'), path.join(appendFixture.dir, 'results')]},
    );
    assert.equal(skipped.skipped, true, 'a redundant closure must be skipped');
    assert.equal(skipped.appended, false);
    assert.equal(skipped.reason, 'intent_already_terminal_in_journal_domain');
    assert.equal(skipped.closures.length, 2, 'both existing closures are reported');
    assert.deepEqual(skipped.closures.map(row => row.matchesProposedClosure), [true, true],
      'the write guard recognises the existing rows as the same closure');
    assert.equal(await fs.readFile(target, 'utf8').then(text => text.trim(), () => ''), '',
      'the skip must not create the target journal');
    assert.equal(Buffer.from(await fs.readFile(appendFixture.secondJournal)).equals(targetBytesBefore), true,
      'the skip must not touch the existing journals');
    checks.push('write side skips a redundant closure');

    const fresh = await closureFixture('fresh');
    const freshTarget = path.join(fresh.dir, 'results', 'daily-inventory-replenishment-2026-09-17.json.journal.ndjson');
    const intentWithJournal = {...REAL_INTENT_ENTRY, journalFile: fresh.sourceJournal};
    const appended = await appendInventoryReconciliationRecord(freshTarget, intentWithJournal, candidateEvent);
    assert.equal(appended.appended, true, 'a first closure is still written');
    assert.equal(appended.closures.length, 0);
    const again = await appendInventoryReconciliationRecord(freshTarget, intentWithJournal, candidateEvent);
    assert.equal(again.skipped, true, 'immediately repeating the same closure is idempotent');
    assert.equal(again.closures.length, 1);
    assert.equal(again.closures[0].journalFile, freshTarget);
    assert.equal(again.closures[0].matchesProposedClosure, true);
    const freshBundle = await readInventoryIntentJournals(
      [fresh.sourceJournal, freshTarget], {maxRunDate: '2026-09-17'});
    assert.equal(freshBundle.terminalOutcomes.size, 1);
    assert.equal(freshBundle.duplicateCrossJournalResolutions.length, 0);
    checks.push('write side keeps the first closure and is idempotent afterwards');

    const scanFixture = await closureFixture('scan', {first: REAL_CLOSURE_MORNING, second: REAL_CLOSURE_ET_GUARD});
    const closures = await findInventoryIntentClosures(REAL_INTENT_ENTRY.intentId, {
      sourceJournal: scanFixture.sourceJournal,
      journalFiles: [scanFixture.sourceJournal, scanFixture.firstJournal, scanFixture.secondJournal],
    });
    assert.equal(closures.length, 2, 'the audit scan finds both closure rows');
    assert.deepEqual(closures.map(row => row.closure), ['cross_journal_resolution', 'cross_journal_resolution']);
    assert.deepEqual(closures.map(row => path.basename(row.journalFile)),
      [path.basename(scanFixture.firstJournal), path.basename(scanFixture.secondJournal)]);
    checks.push('closure scan reports both rows for the audit tool');

    // The controlled audit tool is the operator-facing remediation record: it
    // must reproduce the tolerance decision from the real rows and prove it did
    // not touch a journal.
    const auditOut = path.join(scanFixture.dir, 'audit.json');
    const audit = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'inventory', 'audit_duplicate_cross_journal_resolutions.mjs'),
      '--journal-file', scanFixture.secondJournal,
      '--run-date', MAX_RUN_DATE,
      '--journal-dir', path.join(scanFixture.dir, 'runs'),
      '--journal-dir', path.join(scanFixture.dir, 'results'),
      '--out', auditOut,
    ], {cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
    assert.equal(audit.status, 0, audit.stdout + audit.stderr);
    const artifact = JSON.parse(await fs.readFile(auditOut, 'utf8'));
    assert.equal(artifact.schemaVersion, 'inventory-cross-journal-duplicate-audit/v1');
    assert.equal(artifact.counts.toleratedDuplicateCrossJournalResolutions, 1);
    assert.equal(artifact.journalLinesModified, false);
    assert.equal(artifact.duplicates[0].intentId, REAL_INTENT_ENTRY.intentId);
    assert.equal(artifact.duplicates[0].intentTerminalOutcomeCount, 1,
      'the audited intent must be terminated exactly once');
    assert.equal(artifact.duplicates[0].resolvedDisposition, 'superseded_by_later_plan');
    assert.equal(artifact.duplicates[0].duplicateLine.includes(REAL_INTENT_ENTRY.intentId), true,
      'the audit artifact keeps the verbatim duplicate line');
    const auditedEtJournal = artifact.journalFiles.find(row => row.file === scanFixture.secondJournal);
    assert.equal(auditedEtJournal.sha256,
      crypto.createHash('sha256').update(await fs.readFile(scanFixture.secondJournal)).digest('hex'));
    checks.push('audit tool reports the tolerated duplicate without touching a journal');
  })();
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

console.log(JSON.stringify({ok: true, test: 'inventory_cross_journal_duplicate_tolerance', checks}));
