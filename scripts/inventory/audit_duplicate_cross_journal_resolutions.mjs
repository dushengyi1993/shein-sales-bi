#!/usr/bin/env node
// Controlled audit for duplicate cross-journal inventory closures.
//
// The durable inventory reader tolerates a closure that two journals recorded
// with identical semantics and refuses any real disagreement. This tool makes
// that tolerance auditable without touching the append-only journals: it
// re-reads the managed domain, records every involved journal's exact byte
// hash and the verbatim duplicate lines, and publishes one JSON artifact. It
// never rewrites, truncates or deletes a journal line.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  discoverInventoryJournalFiles,
  inventoryJournalDomainDirectories,
  readInventoryIntentJournals,
} from '../../lib/durable_inventory_write.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/inventory/audit_duplicate_cross_journal_resolutions.mjs \\',
    '    --journal-file <absolute current journal> [--run-date <YYYY-MM-DD>] \\',
    '    [--journal-dir <absolute dir>]... [--out <absolute file>]',
    '',
    'Read-only. Reports duplicate cross-journal closures together with the sha256',
    'of every involved journal and of the verbatim duplicate lines. Journals are',
    'never modified.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {journalFile: '', runDate: '', journalDirectories: [], out: ''};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const next = () => {
      const value = String(argv[index + 1] || '').trim();
      if (!value || value.startsWith('--')) throw new Error(option + ' requires a value');
      index += 1;
      return value;
    };
    if (option === '--journal-file') args.journalFile = path.resolve(next());
    else if (option === '--run-date') args.runDate = next();
    else if (option === '--journal-dir') args.journalDirectories.push(path.resolve(next()));
    else if (option === '--out') args.out = path.resolve(next());
    else if (option === '--help' || option === '-h') { console.log(usage()); process.exit(0); }
    else throw new Error('Unknown argument: ' + option + '\n' + usage());
  }
  if (!args.journalFile) throw new Error('--journal-file is required\n' + usage());
  if (args.runDate && !/^\d{4}-\d{2}-\d{2}$/.test(args.runDate)) throw new Error('--run-date must be YYYY-MM-DD');
  if (!args.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.out = path.join(path.dirname(args.journalFile), 'cross-journal-duplicate-audit-' + stamp + '.json');
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function readLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  return text.split(/\r?\n/).filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const journalDomain = inventoryJournalDomainDirectories({additionalDirectories: args.journalDirectories});
  const files = await discoverInventoryJournalFiles(args.journalFile, {
    includeAll: true,
    additionalDirectories: journalDomain,
  });
  const maxRunDate = args.runDate || new Date().toISOString().slice(0, 10);
  const fileEvidence = [];
  for (const file of files) {
    const bytes = await fs.readFile(file).catch(error => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    fileEvidence.push({
      file,
      exists: Boolean(bytes),
      bytes: bytes ? bytes.length : 0,
      lineCount: bytes ? bytes.toString('utf8').split(/\r?\n/).filter(Boolean).length : 0,
      sha256: bytes ? sha256(bytes) : '',
    });
  }
  const lifecycle = await readInventoryIntentJournals(files, {
    maxRunDate,
    allowMultiplePendingByScope: true,
    currentJournalFile: args.journalFile,
    quarantineHistoricalDanglingSupersedes: true,
  });
  const duplicates = [];
  for (const duplicate of lifecycle.duplicateCrossJournalResolutions || []) {
    const firstLine = (await readLines(duplicate.firstJournalFile))[duplicate.firstLineNumber - 1] || '';
    const duplicateLine = (await readLines(duplicate.duplicateJournalFile))[duplicate.duplicateLineNumber - 1] || '';
    const intentKeys = [...lifecycle.terminalOutcomes.keys()].filter(key => lifecycle.intents.get(key)?.intentId === duplicate.intentId);
    duplicates.push({
      ...duplicate,
      firstLine,
      firstLineSha256: sha256(Buffer.from(firstLine + '\n', 'utf8')),
      duplicateLine,
      duplicateLineSha256: sha256(Buffer.from(duplicateLine + '\n', 'utf8')),
      intentTerminalOutcomeCount: intentKeys.length,
      resolvedDisposition: intentKeys.length === 1
        ? String(lifecycle.terminalOutcomes.get(intentKeys[0])?.disposition || '')
        : '',
    });
  }
  const artifact = {
    schemaVersion: 'inventory-cross-journal-duplicate-audit/v1',
    generatedAt: new Date().toISOString(),
    currentJournalFile: args.journalFile,
    maxRunDate,
    journalDomain,
    journalFiles: fileEvidence,
    counts: {
      journalFiles: fileEvidence.length,
      intents: lifecycle.intents.size,
      pending: lifecycle.pending.size,
      terminalOutcomes: lifecycle.terminalOutcomes.size,
      manualResolutions: lifecycle.manualResolutions.size,
      toleratedDuplicateCrossJournalResolutions: duplicates.length,
      quarantinedSupersedes: (lifecycle.quarantinedSupersedes || []).length,
    },
    duplicates,
    quarantinedSupersedes: lifecycle.quarantinedSupersedes || [],
    journalLinesModified: false,
  };
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out + '.tmp', JSON.stringify(artifact, null, 2) + '\n', {mode: 0o644});
  await fs.rename(args.out + '.tmp', args.out);
  console.log(JSON.stringify({
    ok: true,
    out: args.out,
    toleratedDuplicateCrossJournalResolutions: duplicates.length,
    intents: lifecycle.intents.size,
    pending: lifecycle.pending.size,
    terminalOutcomes: lifecycle.terminalOutcomes.size,
    journalLinesModified: false,
  }, null, 2));
}

await main();

