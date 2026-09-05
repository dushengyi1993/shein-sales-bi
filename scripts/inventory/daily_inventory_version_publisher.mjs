import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeJsonFileAtomic} from '../../lib/atomic_file_publish.mjs';
import {acquireCrossProcessTicketLock} from '../../lib/cross_process_ticket_lock.mjs';
import {discoverInventoryJournalFiles} from '../../lib/inventory_journal_discovery.mjs';

const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const validDate = date => assert(/^\d{4}-\d{2}-\d{2}$/.test(date), 'invalid inventory version date');
const regularBytes = async file => {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), 'Inventory artifact must be a regular file: ' + file);
  return fs.readFile(file);
};
export const fileSha256AndBytes = async file => {
  const bytes = await regularBytes(file);
  return {sha256: sha(bytes), bytes: bytes.length};
};
export const resolveInventoryVersionIndexPath = (root, date) => {
  validDate(date);
  return path.join(root, 'results', 'daily-inventory-replenishment-' + date + '.index.json');
};
export const resolveInventoryLegacyResultPath = (root, date) => path.join(root, 'results', 'daily-inventory-replenishment-' + date + '.json');
export const resolveInventoryLegacyPlanPath = (root, date) => path.join(root, 'plans', 'daily-inventory-replenishment-' + date + '.json');

export async function readDailyInventoryVersionIndex({inventoryRuntimeRoot, date}) {
  try {
    const index = await readJson(resolveInventoryVersionIndexPath(inventoryRuntimeRoot, date));
    assert(index.schemaVersion === 'daily-inventory-replenishment-index/v3' && index.date === date && Array.isArray(index.batches), 'Invalid inventory version index');
    assert(new Set(index.batches.map(b => b.batchId)).size === index.batches.length, 'Duplicate inventory batch identity');
    return index;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function evaluateResultBatchStatus(result, expectedTotal = null) {
  if (!Array.isArray(result?.results) || expectedTotal === null || result.results.length !== expectedTotal) return 'failed';
  if (result.execute !== true) {
    return result.execute === false && result.results.every(row => ['dry_run_ready', 'planned'].includes(row.state)) ? 'dry_run_ready' : 'failed';
  }
  if (result.executionMode !== 'automatic') return 'failed';
  let warning = false;
  for (const row of result.results) {
    if (row.state === 'updated_readback_matched') {
      if (!Number.isFinite(row.targetUsableInventory) || row.after?.totalUsableInventory !== row.targetUsableInventory || !row.writes?.length) return 'failed';
    } else if (row.state === 'skipped_target_already_matched') {
      if (!Number.isFinite(row.targetUsableInventory) || row.before?.totalUsableInventory !== row.targetUsableInventory) return 'failed';
    } else if (row.state === 'skipped_owner_confirmed_same_target_above_target') {
      if (!Number.isFinite(row.targetUsableInventory) || !Number.isFinite(row.before?.totalUsableInventory) || row.before?.totalUsableInventory <= row.targetUsableInventory || row.writes?.length) return 'failed';
    } else if (row.state === 'historical_readback_matched') {
      if (row.historicalIntentClosed !== true || row.deferred !== true || row.disposition !== 'readback_matched'
        || !Number.isSafeInteger(row.historicalTargetUsableInventory)
        || row.before?.totalUsableInventory !== row.historicalTargetUsableInventory
        || row.after?.totalUsableInventory !== row.historicalTargetUsableInventory
        || row.historicalTargetUsableInventory === row.targetUsableInventory || row.writes?.length) return 'failed';
      warning = true;
    } else if (row.state === 'submitted_but_readback_pending' || row.state === 'blocked_by_manual_resolution_fence' || row.state === 'pre_submit_blocked') {
      warning = true;
    } else if (!['skipped_terminal_readback_recorded', 'skipped_safety_no_increase', 'skipped_within_scarcity_band', 'skipped_recovered'].includes(row.state)) return 'failed';
  }
  return warning ? 'warning' : 'done';
}

async function verifyEntry(entry, inventoryRuntimeRoot) {
  assert(entry && Number.isInteger(entry.version) && entry.version > 0, 'Invalid inventory batch entry');
  for (const kind of ['plan', 'result', 'journal', 'marker']) {
    const artifact = entry.artifacts?.[kind];
    assert(artifact?.file && /^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes), 'Incomplete inventory artifact set: ' + kind);
    const current = await fileSha256AndBytes(artifact.file);
    assert(current.sha256 === artifact.sha256 && current.bytes === artifact.bytes, 'Inventory artifact hash/size mismatch: ' + kind);
    if (artifact.snapshot) {
      const file = path.resolve(inventoryRuntimeRoot, artifact.snapshot);
      const relative = path.relative(path.resolve(inventoryRuntimeRoot, 'versions'), file);
      assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Invalid inventory snapshot path');
      const saved = await fileSha256AndBytes(file);
      assert(saved.sha256 === artifact.sha256 && saved.bytes === artifact.bytes, 'Inventory snapshot hash/size mismatch: ' + kind);
    }
  }
  for (const artifact of [...(entry.sourceArtifacts || []), ...(entry.journalArtifacts || [])]) {
    const relative = path.relative(path.resolve(inventoryRuntimeRoot, 'versions'), path.resolve(inventoryRuntimeRoot, artifact.snapshot));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Invalid inventory source snapshot path');
    const current = await fileSha256AndBytes(path.resolve(inventoryRuntimeRoot, artifact.snapshot));
    assert(current.sha256 === artifact.sha256 && current.bytes === artifact.bytes, 'Inventory source snapshot hash/size mismatch');
  }
  return {
    ...entry,
    file: entry.artifacts.result.file,
    planFile: entry.artifacts.plan.file,
    journalFile: entry.artifacts.journal.file,
    markerFile: entry.artifacts.marker.file,
    sha256: entry.artifacts.result.sha256,
    bytes: entry.artifacts.result.bytes,
    isFromIndex: true,
  };
}

export async function resolveResultEvidenceArtifact({
  inventoryRuntimeRoot, date, sha256 = '', bytes = null, batchId = '', commandId = '', preferActive = false,
}) {
  const index = await readDailyInventoryVersionIndex({inventoryRuntimeRoot, date});
  if (index) {
    const entry = index.batches.find(b => {
      if (batchId && b.batchId !== batchId) return false;
      if (commandId && b.commandId !== commandId) return false;
      if (sha256 && b.artifacts?.result?.sha256 !== sha256) return false;
      if (bytes !== null && b.artifacts?.result?.bytes !== Number(bytes)) return false;
      return batchId || commandId || sha256 || (preferActive && b.batchId === index.latestBatchId);
    });
    return entry ? verifyEntry(entry, inventoryRuntimeRoot) : null;
  }
  // Explicit identities must never fall through to an unrelated legacy result.
  if (batchId || commandId || !sha256) return null;
  const file = resolveInventoryLegacyResultPath(inventoryRuntimeRoot, date);
  try {
    const actual = await fileSha256AndBytes(file);
    if (actual.sha256 !== sha256 || (bytes !== null && actual.bytes !== Number(bytes))) return null;
    return {file, ...actual, version: 1, batchId: 'legacy', status: 'unverified', isFromIndex: false};
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function collectArtifacts({stagingPlanFile, stagingResultFile, stagingJournalFile, stagingMarkerFile}) {
  const files = {plan: stagingPlanFile, result: stagingResultFile, journal: stagingJournalFile || stagingResultFile + '.journal.ndjson', marker: stagingMarkerFile};
  const artifacts = {};
  const raw = {};
  for (const [kind, file] of Object.entries(files)) {
    assert(file, 'Missing required inventory artifact: ' + kind);
    raw[kind] = await regularBytes(file);
    artifacts[kind] = {file: path.resolve(file), sha256: sha(raw[kind]), bytes: raw[kind].length};
  }
  const plan = JSON.parse(raw.plan);
  const result = JSON.parse(raw.result);
  const marker = JSON.parse(raw.marker);
  assert(Array.isArray(plan.actionable) && /^[a-f0-9]{64}$/.test(plan.payloadHash), 'Inventory plan is incomplete');
  assert(result.planHash === plan.payloadHash && Array.isArray(result.results) && result.results.length === plan.actionable.length, 'Inventory result does not cover the exact plan');
  const identity = row => JSON.stringify([row.storeKey, row.skc, row.skuCode, row.targetUsableInventory]);
  const expectedRows = plan.actionable.map(identity).sort();
  const actualRows = result.results.map(identity).sort();
  assert(new Set(expectedRows).size === expectedRows.length && JSON.stringify(expectedRows) === JSON.stringify(actualRows), 'Inventory result object/target coverage conflict');
  const status = evaluateResultBatchStatus(result, plan.actionable.length);
  assert(marker.stage === 'daily-inventory-guard' && marker.runDate === plan.date, 'Inventory marker does not belong to this plan');
  assert(marker.status === (status === 'dry_run_ready' ? 'done' : status), 'Inventory marker/result status conflict');
  assert(marker.ok === ['done', 'warning', 'dry_run_ready'].includes(status), 'Inventory marker ok/status conflict');
  const priorDate = new Date(plan.date + 'T12:00:00Z');
  priorDate.setUTCDate(priorDate.getUTCDate() - 1);
  assert(marker.businessDate === priorDate.toISOString().slice(0, 10), 'Inventory marker business date conflict');
  assert(Array.isArray(marker.evidence) && marker.evidence.length === 2, 'Inventory marker must bind exact plan and result');
  for (const kind of ['plan', 'result']) {
    const expected = artifacts[kind];
    const entry = marker.evidence.find(e => e.path && path.resolve(e.path) === expected.file && e.sha256 === expected.sha256 && e.bytes === expected.bytes);
    assert(entry, 'Inventory marker lacks exact ' + kind + ' evidence');
  }
  return {artifacts, raw, plan, result, status};
}

async function saveSnapshot(directory, raw, artifacts, inventoryRuntimeRoot) {
  await fs.mkdir(directory, {recursive: true});
  for (const [kind, bytes] of Object.entries(raw)) {
    const file = path.join(directory, kind === 'journal' ? 'journal.ndjson' : kind + '.json');
    await writeImmutableFile(file, bytes);
    artifacts[kind].snapshot = path.relative(inventoryRuntimeRoot, file);
  }
}

async function makeEntry(options, version) {
  const journal = path.resolve(options.stagingJournalFile || options.stagingResultFile + '.journal.ndjson');
  const discover = async () => [...new Set([journal, ...(await discoverInventoryJournalFiles(journal, {
    includeAll: true,
    additionalDirectories: String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS || '').split(path.delimiter).filter(Boolean),
  })).map(file => path.resolve(file))])].sort();
  const deadline = Date.now() + 30_000;
  for (let attempt = 0; attempt < 3; attempt++) {
    const files = await discover();
    const releases = [];
    try {
      // All publishers acquire the entire set in the same order; appenders use
      // these same tickets. Never hold the current journal first (ABBA).
      for (const file of files) {
        assert(Date.now() < deadline, 'Inventory publication journal lock deadline exceeded');
        releases.push(await acquireCrossProcessTicketLock(file + '.publication.lock', {
          timeoutMs: Math.max(1, deadline - Date.now()),
        }));
      }
      if (JSON.stringify(files) !== JSON.stringify(await discover())) continue;
      return await makeLockedEntry({...options, publicationJournalFiles: files, verifyJournalSet: async () => {
        assert(JSON.stringify(files) === JSON.stringify(await discover()), 'Inventory publication journal set changed');
      }}, version);
    } finally {
      for (const release of releases.reverse()) await release();
    }
  }
  throw new Error('Inventory publication journal discovery did not stabilize');
}

async function writeImmutableFile(file, bytes) {
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    assert((await regularBytes(file)).equals(Buffer.from(bytes)), 'Immutable inventory file conflict');
  }
  if (process.platform !== 'win32') {
    const handle = await fs.open(path.dirname(file), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

async function makeLockedEntry(options, version) {
  const {artifacts, raw, plan, result, status} = await collectArtifacts(options);
  assert(plan.date === options.date, 'Inventory publication date/plan conflict');
  const directory = path.join(options.inventoryRuntimeRoot, 'versions', options.date, sha(options.batchId).slice(0, 40));
  await saveSnapshot(directory, raw, artifacts, options.inventoryRuntimeRoot);
  const sourceArtifacts = [];
  const journalArtifacts = [];
  const journalFiles = options.publicationJournalFiles;
  for (const file of journalFiles) {
    const bytes = await regularBytes(file);
    const snapshotFile = path.join(directory, 'journals', sha(file) + '.ndjson');
    await fs.mkdir(path.dirname(snapshotFile), {recursive: true});
    await writeImmutableFile(snapshotFile, bytes);
    journalArtifacts.push({file, sha256: sha(bytes), bytes: bytes.length, snapshot: path.relative(options.inventoryRuntimeRoot, snapshotFile)});
  }
  const evidenceRoot = options.root || process.env.SHEIN_BI_ROOT || process.cwd();
  const bindings = new Map();
  const bind = (file, hash) => {
    if (!file || !hash) return;
    const absolute = path.resolve(evidenceRoot, file);
    assert(!bindings.has(absolute) || bindings.get(absolute) === hash, 'Conflicting inventory source binding');
    bindings.set(absolute, hash);
  };
  for (const evidence of plan.sourceEvidence || []) {
    bind(evidence.file, evidence.sha256);
    bind(evidence.manifestOriginalFile, evidence.manifestOriginalSha256);
    bind(evidence.terminalEvidenceFile, evidence.terminalEvidenceSha256);
    for (const cache of evidence.cacheBindings || []) bind(cache.cacheFile, cache.cacheSha256);
  }
  for (const [file, expectedHash] of bindings) {
    const bytes = await regularBytes(file);
    assert(sha(bytes) === expectedHash, 'Inventory source changed before immutable publication');
    const snapshotFile = path.join(directory, 'sources', expectedHash + '.json');
    await fs.mkdir(path.dirname(snapshotFile), {recursive: true});
    await writeImmutableFile(snapshotFile, bytes);
    sourceArtifacts.push({file, sha256: expectedHash, bytes: bytes.length, snapshot: path.relative(options.inventoryRuntimeRoot, snapshotFile)});
  }
  const entry = {
    batchId: options.batchId, commandId: options.commandId, version, artifacts, sourceArtifacts, journalArtifacts,
    planHash: plan.payloadHash, status, generatedAt: result.generatedAt,
    counts: {
      total: result.results.length,
      updated: result.results.filter(r => r.state === 'updated_readback_matched').length,
      skipped: result.results.filter(r => r.state.startsWith('skipped_')).length,
      pending: result.results.filter(r => r.state === 'submitted_but_readback_pending').length,
      fenced: result.results.filter(r => r.state === 'blocked_by_manual_resolution_fence').length,
      blocked: result.results.filter(r => r.state === 'blocked').length,
    },
  };
  await verifyEntry(entry, options.inventoryRuntimeRoot);
  await options.verifyJournalSet();
  const sealFile = artifacts.journal.file + '.sealed.json';
  const seal = {schemaVersion: 'inventory-journal-seal/v1', sha256: artifacts.journal.sha256, bytes: artifacts.journal.bytes};
  await writeImmutableFile(sealFile, JSON.stringify(seal) + '\n');
  if (process.platform !== 'win32') {
    for (let dir = directory; ; dir = path.dirname(dir)) {
      const handle = await fs.open(dir, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      if (dir === path.resolve(options.inventoryRuntimeRoot) || path.dirname(dir) === dir) break;
    }
  }
  return entry;
}

export async function ensureLegacyExecutionArtifactsPreserved({inventoryRuntimeRoot, date, markerRoot}) {
  const resultFile = resolveInventoryLegacyResultPath(inventoryRuntimeRoot, date);
  try { await fs.access(resultFile); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assert(markerRoot, 'Legacy inventory preservation requires its marker root');
  return makeEntry({
    inventoryRuntimeRoot, date, batchId: 'legacy-' + date, commandId: 'morning:' + date,
    stagingPlanFile: resolveInventoryLegacyPlanPath(inventoryRuntimeRoot, date),
    stagingResultFile: resultFile, stagingJournalFile: resultFile + '.journal.ndjson',
    stagingMarkerFile: path.join(markerRoot, date, 'daily-inventory-guard.json'),
  }, 1);
}
export const ensureLegacyResultArchivedAsVersionOne = ensureLegacyExecutionArtifactsPreserved;

export async function publishDailyInventoryResultVersion(options) {
  const {inventoryRuntimeRoot, date, batchId, commandId, markerRoot, beforeIndexRename} = options;
  validDate(date);
  assert(batchId && commandId, 'Inventory publication requires batchId and commandId');
  const indexFile = resolveInventoryVersionIndexPath(inventoryRuntimeRoot, date);
  const release = await acquireCrossProcessTicketLock(indexFile + '.lock');
  try {
    const index = await readDailyInventoryVersionIndex({inventoryRuntimeRoot, date});
    const batches = [...(index?.batches || [])];
    const prior = batches.find(b => b.batchId === batchId || b.commandId === commandId);
    if (prior) {
      assert(prior.batchId === batchId && prior.commandId === commandId, 'Inventory publication identity conflict');
      const current = await collectArtifacts(options);
      for (const kind of Object.keys(current.artifacts)) assert(current.artifacts[kind].sha256 === prior.artifacts[kind].sha256, 'Immutable published inventory command changed');
      return verifyEntry(prior, inventoryRuntimeRoot);
    }
    if (!index && markerRoot && path.resolve(options.stagingResultFile) !== path.resolve(resolveInventoryLegacyResultPath(inventoryRuntimeRoot, date))) {
      const legacy = await ensureLegacyExecutionArtifactsPreserved({inventoryRuntimeRoot, date, markerRoot});
      if (legacy) batches.push(legacy);
    }
    const version = Math.max(0, ...batches.map(b => b.version)) + 1;
    const entry = await makeEntry(options, version);
    batches.push(entry);
    // Only this atomic rename changes the active complete tuple. No legacy
    // plan/result/journal/marker projection is ever overwritten.
    const updated = {
      schemaVersion: 'daily-inventory-replenishment-index/v3', date,
      latestVersion: version, latestBatchId: batchId,
      activeVersion: version, activeStatus: entry.status,
      updatedAt: new Date().toISOString(), batches,
    };
    await writeJsonFileAtomic(indexFile, updated, {mode: 0o600, beforeRename: beforeIndexRename});
    return verifyEntry(entry, inventoryRuntimeRoot);
  } finally { await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, root, date, batchId, commandId, plan, result, marker, markerRoot] = process.argv.slice(2);
  try {
    const options = {inventoryRuntimeRoot: root, date, batchId, commandId};
    const value = command === 'read'
      ? await resolveResultEvidenceArtifact({...options, preferActive: !batchId && !commandId})
      : command === 'publish'
        ? await publishDailyInventoryResultVersion({...options, stagingPlanFile: plan, stagingResultFile: result, stagingMarkerFile: marker, markerRoot})
        : (() => { throw new Error('Inventory version command must be read or publish'); })();
    process.stdout.write(JSON.stringify(value) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
