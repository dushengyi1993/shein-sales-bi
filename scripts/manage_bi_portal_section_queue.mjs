#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_FILE = process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE
  || path.join(process.cwd(), 'state', 'portal-section-queue', 'queue.json');
const SECTION_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const QUEUE_AGING_INTERVAL_MS = 2 * 60 * 1_000;
const DEFAULT_FAIL_BACKOFF_SECONDS = 60;
// Durable per-section idempotency key: strict bounded safe characters so it
// can never be interpreted as a section, path or shell argument.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const COMPLETED_LEDGER_MAX_ENTRIES = 2_048;
const COMPLETED_LEDGER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  manage_bi_portal_section_queue.mjs enqueue --sections CSV [--priority N] [--reason TEXT] [--idempotency-key KEY] [--requeue-completed-sections CSV] [--file PATH]
  manage_bi_portal_section_queue.mjs claim [--lease-seconds N] [--exclude-sections CSV] [--file PATH]
  manage_bi_portal_section_queue.mjs complete --section NAME --lease-id ID [--file PATH]
  manage_bi_portal_section_queue.mjs fail --section NAME --lease-id ID [--error TEXT] [--backoff-seconds N] [--file PATH]
  manage_bi_portal_section_queue.mjs status [--file PATH]`);
  return 64;
}

function validateIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) throw new TypeError('QUEUE_IDEMPOTENCY_KEY_INVALID');
  return key;
}

function normalizeSection(value) {
  const section = String(value || '').trim();
  if (!SECTION_PATTERN.test(section)) throw new TypeError(`SECTION_INVALID_${section}`);
  return section;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!['enqueue', 'claim', 'complete', 'fail', 'status'].includes(command)) {
    throw new TypeError('QUEUE_COMMAND_INVALID');
  }
  const options = {
    command,
    file: DEFAULT_FILE,
    sections: [],
    requeueCompletedSections: [],
    priority: 50,
    reason: '',
    idempotencyKey: '',
    section: '',
    leaseId: undefined,
    leaseSeconds: 2_700,
    excludeSections: [],
    error: '',
    backoffSeconds: DEFAULT_FAIL_BACKOFF_SECONDS,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new TypeError(`QUEUE_VALUE_MISSING_${token}`);
      return tokens[index];
    };
    if (token === '--file') options.file = path.resolve(next());
    else if (token === '--sections') {
      options.sections.push(...next().split(',').map(normalizeSection));
    } else if (token === '--priority') options.priority = Number(next());
    else if (token === '--reason') options.reason = next();
    else if (token === '--idempotency-key') options.idempotencyKey = validateIdempotencyKey(next());
    else if (token === '--requeue-completed-sections') {
      options.requeueCompletedSections.push(...next().split(',').map(normalizeSection));
    }
    else if (token === '--section') options.section = normalizeSection(next());
    else if (token === '--lease-id') options.leaseId = next();
    else if (token === '--lease-seconds') options.leaseSeconds = Number(next());
    else if (token === '--exclude-sections') {
      options.excludeSections.push(...next().split(',').map(normalizeSection));
    }
    else if (token === '--error') options.error = next();
    else if (token === '--backoff-seconds') options.backoffSeconds = Number(next());
    else throw new TypeError(`QUEUE_ARGUMENT_UNKNOWN_${token}`);
  }
  if (!Number.isSafeInteger(options.priority) || options.priority < 0 || options.priority > 1_000) {
    throw new TypeError('QUEUE_PRIORITY_INVALID');
  }
  if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 30 || options.leaseSeconds > 86_400) {
    throw new TypeError('QUEUE_LEASE_SECONDS_INVALID');
  }
  if (!Number.isSafeInteger(options.backoffSeconds) || options.backoffSeconds < 0 || options.backoffSeconds > 3_600) {
    throw new TypeError('QUEUE_BACKOFF_SECONDS_INVALID');
  }
  if (command === 'enqueue' && !options.sections.length) throw new TypeError('QUEUE_SECTIONS_REQUIRED');
  if (options.requeueCompletedSections.length) {
    if (!options.idempotencyKey) throw new TypeError('QUEUE_REQUEUE_REQUIRES_IDEMPOTENCY_KEY');
    const requested = new Set(options.sections);
    if (options.requeueCompletedSections.some(section => !requested.has(section))) {
      throw new TypeError('QUEUE_REQUEUE_NOT_REQUESTED');
    }
  }
  if (['complete', 'fail'].includes(command) && (!options.section || !options.leaseId)) {
    throw new TypeError('QUEUE_LEASE_TARGET_REQUIRED');
  }
  return options;
}

function emptyQueue() {
  return {
    version: 1,
    updatedAt: '',
    nextSequence: 0,
    entries: [],
    completedIdempotency: [],
  };
}

// Old queue.json files predate sequence/requestRevision/claimedRevision/
// nextAttemptAt. Normalize deterministically on every read so legacy entries
// keep working and repeated reads of the same file stay stable.
function normalizeQueue(queue) {
  let nextSequence = Number.isSafeInteger(queue.nextSequence) && queue.nextSequence >= 0
    ? queue.nextSequence
    : 0;
  for (const entry of queue.entries) {
    if (!entry || typeof entry !== 'object') continue;
    const sequence = Number(entry.sequence || 0);
    entry.sequence = Number.isSafeInteger(sequence) && sequence > 0 ? sequence : nextSequence + 1;
    if (entry.sequence > nextSequence) nextSequence = entry.sequence;
    const requestRevision = Number(entry.requestRevision || 0);
    entry.requestRevision = Number.isSafeInteger(requestRevision) && requestRevision > 0 ? requestRevision : 1;
    const claimedRevision = Number(entry.claimedRevision ?? NaN);
    const claimedValid = Number.isSafeInteger(claimedRevision) && claimedRevision >= 0;
    if (entry.status === 'running' && (!claimedValid || claimedRevision === 0)) {
      // A legacy running entry was claimed before revisions existed; treat its
      // requestRevision as the revision that lease was processing.
      entry.claimedRevision = entry.requestRevision;
    } else if (claimedValid) {
      entry.claimedRevision = claimedRevision;
    } else {
      entry.claimedRevision = 0;
    }
    entry.nextAttemptAt = typeof entry.nextAttemptAt === 'string' ? entry.nextAttemptAt : '';
    entry.rerun = Boolean(entry.rerun);
    const rerunPriority = Number(entry.rerunPriority ?? NaN);
    entry.rerunPriority = Number.isSafeInteger(rerunPriority) && rerunPriority >= 0 ? rerunPriority : null;
    entry.dependencyYield = Boolean(entry.dependencyYield);
    entry.idempotencyKey = typeof entry.idempotencyKey === 'string' ? entry.idempotencyKey : '';
    const priority = Number(entry.priority ?? 50);
    entry.priority = Number.isSafeInteger(priority) && priority >= 0 ? priority : 50;
    if (!['pending', 'running'].includes(entry.status)) entry.status = 'pending';
  }
  queue.nextSequence = nextSequence;
  return queue;
}

function readQueue(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeQueue({
      version: 1,
      updatedAt: String(value?.updatedAt || ''),
      nextSequence: Number(value?.nextSequence || 0),
      entries: Array.isArray(value?.entries) ? value.entries : [],
      completedIdempotency: Array.isArray(value?.completedIdempotency) ? value.completedIdempotency : [],
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyQueue();
    throw error;
  }
}

function writeQueue(file, queue) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o770});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    ...queue,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o660,
  });
  fs.renameSync(temporary, file);
  return payload;
}

function recoverExpired(queue, nowMillis) {
  for (const entry of queue.entries) {
    if (entry.status !== 'running') continue;
    const expiresAt = Date.parse(entry.leaseExpiresAt || '');
    if (!entry.leaseId || Number.isNaN(expiresAt) || expiresAt <= nowMillis) {
      entry.status = 'pending';
      entry.leaseId = '';
      entry.leaseExpiresAt = '';
      entry.lastError = entry.lastError || 'worker lease expired';
    }
  }
}

export function enqueueSections(queue, {
  sections,
  priority = 50,
  reason = '',
  idempotencyKey = '',
  requeueCompletedSections = [],
  now = new Date(),
} = {}) {
  const nowIso = now.toISOString();
  const key = validateIdempotencyKey(idempotencyKey);
  if (requeueCompletedSections.length && !key) {
    throw new TypeError('QUEUE_REQUEUE_REQUIRES_IDEMPOTENCY_KEY');
  }
  const requestedSet = new Set((sections || []).map(normalizeSection));
  const requeueSet = new Set(requeueCompletedSections.map(normalizeSection));
  if (requeueCompletedSections.some(section => !requestedSet.has(normalizeSection(section)))) {
    throw new TypeError('QUEUE_REQUEUE_NOT_REQUESTED');
  }
  // Expired/over-bound tombstones are trimmed BEFORE any lookup using the
  // caller-provided now; the trimmed ledger must be persisted even when no
  // entry changes (trim reports whether it mutated the document).
  let mutated = trimCompletedIdempotency(queue, now);
  let nextSequence = Number.isSafeInteger(queue.nextSequence) && queue.nextSequence >= 0
    ? queue.nextSequence
    : 0;
  for (const entry of queue.entries) {
    const sequence = Number(entry?.sequence || 0);
    if (Number.isSafeInteger(sequence) && sequence > nextSequence) nextSequence = sequence;
  }
  queue.nextSequence = nextSequence;
  const outcome = {
    newlyQueued: [],
    updatedRevision: [],
    deduplicatedPending: [],
    deduplicatedCompleted: [],
    coalescedRerun: [],
    requeuedCompleted: [],
    supersededByExisting: [],
  };
  for (const rawSection of sections || []) {
    const section = normalizeSection(rawSection);
    const entryKey = key ? `${key}::${section}` : '';
    let entry = queue.entries.find(candidate => candidate.section === section);
    // Cross-generation requeue conflict: when a requeue targets a section
    // that already has an entry bound to a DIFFERENT nonempty idempotency
    // key (a newer generation), the requeue is a strict no-op: the old
    // tombstone is NOT deleted, the newer entry is NOT adopted/revisioned/
    // rerun, and the section is classified supersededByExisting so the caller
    // re-reads live state and defers to the newer generation instead of
    // claiming this generation queued/done.  Same key or no entry requeue
    // normally below.
    if (requeueSet.has(section) && entryKey && entry?.idempotencyKey && entry.idempotencyKey !== entryKey) {
      outcome.supersededByExisting.push(section);
      continue;
    }
    // A narrow requeue of invalid completed sections: under the same lock and
    // mutation, remove ONLY the matching ${key}::section tombstones for the
    // listed sections so the normal enqueue below recreates their entries;
    // valid tombstones stay untouched.  No manual deletes.
    if (requeueSet.has(section) && entryKey && Array.isArray(queue.completedIdempotency)) {
      const before = queue.completedIdempotency.length;
      queue.completedIdempotency = queue.completedIdempotency.filter(record => record.idempotencyKey !== entryKey);
      if (queue.completedIdempotency.length !== before) {
        outcome.requeuedCompleted.push(section);
        mutated = true;
      }
    }
    // A NON-expired completed tombstone check MUST precede the existing-entry
    // logic: replaying a completed G1 is a strict no-op even when the current
    // entry is a newer G2 request -- G2's key/revision/status stay untouched
    // and the old key is never adopted.  Only an expired/trimmed tombstone
    // (declared 30d semantics) makes the request eligible again.
    if (entryKey && Array.isArray(queue.completedIdempotency)
      && queue.completedIdempotency.some(record => record.idempotencyKey === entryKey)) {
      outcome.deduplicatedCompleted.push(section);
      continue;
    }
    // Durable per-section idempotency: an existing pending/running entry with
    // the exact same key is a strict no-op (no revision bump, no rerun, no
    // lease/backoff reset).
    if (entry && entryKey && entry.idempotencyKey === entryKey) {
      outcome.deduplicatedPending.push(section);
      continue;
    }
    if (!entry) {
      queue.nextSequence += 1;
      entry = {
        section,
        sequence: queue.nextSequence,
        priority,
        requestRevision: 1,
        claimedRevision: 0,
        rerun: false,
        rerunPriority: null,
        dependencyYield: false,
        ...(entryKey ? {idempotencyKey: entryKey} : {}),
        status: 'pending',
        requestedAt: nowIso,
        updatedAt: nowIso,
        reasons: [],
        attempts: 0,
        leaseId: '',
        leaseExpiresAt: '',
        nextAttemptAt: '',
        lastError: '',
      };
      queue.entries.push(entry);
      outcome.newlyQueued.push(section);
      mutated = true;
    } else {
      // A legacy entry without a key, or an entry bound to a different key,
      // keeps the old behavior; the entry adopts the new key so later
      // duplicates of this request deduplicate correctly.
      if (entryKey && entry.idempotencyKey !== entryKey) {
        entry.idempotencyKey = entryKey;
        mutated = true;
      }
      entry.priority = Math.min(Number(entry.priority ?? priority), priority);
      // One running lease needs at most one coalesced rerun. Repeated events
      // during the same build update its audit metadata without creating an
      // unbounded revision chase that can starve dependent homepage sections.
      const alreadyHasRerun = entry.status === 'running' && entry.rerun === true;
      const revisionBefore = Number(entry.requestRevision || 0);
      if (!alreadyHasRerun) {
        entry.requestRevision = revisionBefore + 1;
      }
      entry.updatedAt = nowIso;
      // An explicit new request supersedes failure backoff. The revision
      // guard still prevents an older running lease from completing it.
      entry.nextAttemptAt = '';
      // A re-enqueue while a lease is still running must not delete or split
      // the entry: keep the worker on the old revision, mark the rerun, and
      // let complete/fail reconcile the revision before the entry is free.
      if (entry.status === 'running') {
        entry.rerun = true;
        entry.rerunPriority = entry.rerunPriority == null
          ? priority
          : Math.min(Number(entry.rerunPriority), priority);
      }
      if (entry.status !== 'running') entry.status = 'pending';
      // Coalescing: a repeated request on an already-rerun running entry does
      // not increase the numeric revision -- classify it explicitly instead of
      // claiming an updatedRevision.
      if (alreadyHasRerun && Number(entry.requestRevision) === revisionBefore) {
        outcome.coalescedRerun.push(section);
      } else {
        outcome.updatedRevision.push(section);
      }
      mutated = true;
    }
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason.slice(0, 300));
  }
  return {
    queue,
    mutated,
    ...outcome,
    // Legacy aggregate kept for backward compatibility; the structured
    // arrays above carry the exact semantics.
    deduplicated: [...outcome.deduplicatedPending, ...outcome.deduplicatedCompleted],
  };
}

export function claimNext(queue, {
  leaseSeconds = 2_700,
  now = new Date(),
  leaseId = crypto.randomUUID(),
  excludeSections = [],
} = {}) {
  const nowMillis = now.getTime();
  recoverExpired(queue, nowMillis);
  // A dependent homepage artifact must never publish from the old profit
  // cache while a newer profit request is pending, running, or backing off.
  // This is a dependency barrier, not just a priority hint: even a priority-0
  // force refresh waits for the canonical profit entry to finish.
  const profitEntry = queue.entries.find(entry => (
    entry.section === 'profit' && ['pending', 'running'].includes(entry.status)
  ));
  const profitBlocksHomeRankings = Boolean(
    profitEntry && (profitEntry.status === 'running' || profitEntry.dependencyYield !== true)
  );
  const profitBlocksHomeProfit = Boolean(profitEntry);
  const excluded = new Set((excludeSections || []).map(normalizeSection));
  // A steady stream of priority-10 accounting work used to keep priority-50
  // daily/page caches pending forever.  Age lowers the effective priority by
  // one point every two minutes, but never ahead of an explicit priority-0
  // operator refresh.  This keeps urgent work urgent while placing a hard
  // bound on starvation for the rest of the queue.  Within an equal effective
  // priority, the explicit owner priority decides before age, so an aged
  // priority-10 home partition still beats an older aged priority-50 background
  // job even though an even older background job wins over one that has not
  // aged yet.
  const effectivePriority = entry => {
    const priority = Math.max(0, Number(entry.priority || 0));
    if (priority === 0) return 0;
    const requestedAt = Date.parse(entry.requestedAt || '');
    const waitedMillis = Number.isFinite(requestedAt) ? Math.max(0, nowMillis - requestedAt) : 0;
    const ageCredit = Math.floor(waitedMillis / QUEUE_AGING_INTERVAL_MS);
    // homeProfit depends on profit. Keep ordinary priority-10 homeProfit above
    // the priority-5 profit lane even when an old queue entry has accumulated
    // age credit; an explicit priority-0 homeProfit refresh remains urgent.
    const floor = entry.section === 'homeProfit' && priority >= 10 ? 6 : 1;
    return Math.max(floor, priority - ageCredit);
  };
  const pending = queue.entries
    .filter(entry => {
      if (entry.status !== 'pending') return false;
      // One bounded worker slot should make progress across distinct sections.
      // Re-claiming the same hot section twice in one run lets continuous
      // orders consume every slot and starves daily rankings/traffic forever.
      if (excluded.has(entry.section)) return false;
      if (entry.section === 'homeRankings' && profitBlocksHomeRankings) return false;
      if (entry.section === 'homeProfit' && profitBlocksHomeProfit) return false;
      const nextAttemptAt = Date.parse(entry.nextAttemptAt || '');
      return Number.isNaN(nextAttemptAt) || nextAttemptAt <= nowMillis;
    })
    .sort((left, right) => (
      effectivePriority(left) - effectivePriority(right)
      || Number(left.priority || 0) - Number(right.priority || 0)
      // Within the same priority, sequence (enqueue order) decides instead of
      // the section name, so a profit,homeProfit batch always claims profit
      // first and the homepage summary never derives from a missing source.
      || Number(left.sequence || 0) - Number(right.sequence || 0)
    ));
  const entry = pending[0];
  if (!entry) return null;
  entry.status = 'running';
  entry.attempts = Number(entry.attempts || 0) + 1;
  entry.leaseId = leaseId;
  entry.leaseExpiresAt = new Date(nowMillis + leaseSeconds * 1_000).toISOString();
  entry.claimedRevision = Number(entry.requestRevision || 0);
  entry.rerun = false;
  entry.dependencyYield = false;
  entry.updatedAt = now.toISOString();
  return {...entry};
}

export function completeClaim(queue, {section, leaseId, now = new Date()} = {}) {
  const normalizedSection = normalizeSection(section);
  const index = queue.entries.findIndex(entry => entry.section === normalizedSection);
  if (index < 0) return false;
  const entry = queue.entries[index];
  if (entry.status !== 'running' || entry.leaseId !== leaseId) {
    throw new Error('QUEUE_LEASE_MISMATCH');
  }
  if (Number(entry.requestRevision) !== Number(entry.claimedRevision)) {
    // The entry was re-enqueued while this lease ran. A complete for the old
    // revision must not delete the newer request: release the lease back to
    // pending with no backoff so the new revision can be claimed immediately.
    entry.status = 'pending';
    entry.leaseId = '';
    entry.leaseExpiresAt = '';
    entry.nextAttemptAt = '';
    entry.dependencyYield = entry.section === 'profit';
    if (Number.isSafeInteger(Number(entry.rerunPriority))) entry.priority = Number(entry.rerunPriority);
    entry.rerunPriority = null;
    queue.nextSequence = Math.max(Number(queue.nextSequence || 0), ...queue.entries.map(item => Number(item.sequence || 0))) + 1;
    entry.sequence = queue.nextSequence;
    entry.lastError = `complete superseded by requestRevision=${Number(entry.requestRevision)}`;
    entry.updatedAt = now.toISOString();
    return false;
  }
  queue.entries.splice(index, 1);
  if (entry.idempotencyKey) {
    // Final completion tombstones the durable idempotency key so a later
    // Portal restart with the same request is a no-op instead of a
    // re-enqueue of a fresh revision.
    queue.completedIdempotency = Array.isArray(queue.completedIdempotency) ? queue.completedIdempotency : [];
    queue.completedIdempotency.push({
      idempotencyKey: entry.idempotencyKey,
      section: entry.section,
      completedAt: now.toISOString(),
    });
    trimCompletedIdempotency(queue, now);
  }
  return true;
}

function trimCompletedIdempotency(queue, now = new Date()) {
  const nowMillis = now.getTime();
  const records = Array.isArray(queue.completedIdempotency) ? queue.completedIdempotency : [];
  const current = (records || []).filter(record => {
    const at = Date.parse(String(record?.completedAt || ''));
    return Number.isFinite(at) && nowMillis - at <= COMPLETED_LEDGER_MAX_AGE_MS;
  });
  current.sort((left, right) => Date.parse(String(right.completedAt || '')) - Date.parse(String(left.completedAt || '')));
  queue.completedIdempotency = current.slice(0, COMPLETED_LEDGER_MAX_ENTRIES);
  // Whether any ledger record was actually removed (expired or over the count
  // bound); a caller that persisted nothing else must still write the trimmed
  // ledger so expired tombstones are durably removed.
  return queue.completedIdempotency.length !== (records || []).length;
}

export function failClaim(queue, {
  section,
  leaseId,
  error = '',
  now = new Date(),
  backoffSeconds = DEFAULT_FAIL_BACKOFF_SECONDS,
} = {}) {
  const normalizedSection = normalizeSection(section);
  const entry = queue.entries.find(candidate => candidate.section === normalizedSection);
  if (!entry) return false;
  if (entry.status !== 'running' || entry.leaseId !== leaseId) {
    throw new Error('QUEUE_LEASE_MISMATCH');
  }
  const newerRevisionPending = Number(entry.requestRevision) > Number(entry.claimedRevision);
  entry.status = 'pending';
  entry.leaseId = '';
  entry.leaseExpiresAt = '';
  // A failed section must not be immediately re-claimed by the same worker:
  // deterministic nextAttemptAt. A re-enqueue received while the lease was
  // running (newer requestRevision) is an explicit new request, so that case
  // stays immediately claimable for the rerun.
  const delaySeconds = Number.isSafeInteger(backoffSeconds) && backoffSeconds >= 0 ? backoffSeconds : 0;
  entry.nextAttemptAt = newerRevisionPending
    ? ''
    : new Date(now.getTime() + delaySeconds * 1_000).toISOString();
  entry.dependencyYield = false;
  if (newerRevisionPending) {
    if (Number.isSafeInteger(Number(entry.rerunPriority))) entry.priority = Number(entry.rerunPriority);
    entry.rerunPriority = null;
    queue.nextSequence = Math.max(Number(queue.nextSequence || 0), ...queue.entries.map(item => Number(item.sequence || 0))) + 1;
    entry.sequence = queue.nextSequence;
  }
  entry.lastError = String(error || 'section refresh failed').slice(0, 1_000);
  entry.updatedAt = now.toISOString();
  return true;
}

function statusPayload(queue, file) {
  const counts = queue.entries.reduce((accumulator, entry) => {
    const status = String(entry.status || 'unknown');
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {});
  return {
    ok: true,
    file,
    updatedAt: queue.updatedAt,
    counts,
    entries: queue.entries,
  };
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ok: false, errorCode: error?.message || 'QUEUE_ARGUMENT_INVALID'}));
    return usage();
  }
  const queue = readQueue(options.file);
  if (options.command === 'enqueue') {
    const outcome = enqueueSections(queue, options);
    const saved = outcome.mutated ? writeQueue(options.file, outcome.queue) : outcome.queue;
    console.log(JSON.stringify({
      ...statusPayload(saved, options.file),
      newlyQueued: outcome.newlyQueued,
      updatedRevision: outcome.updatedRevision,
      deduplicatedPending: outcome.deduplicatedPending,
      deduplicatedCompleted: outcome.deduplicatedCompleted,
      coalescedRerun: outcome.coalescedRerun,
      requeuedCompleted: outcome.requeuedCompleted,
      supersededByExisting: outcome.supersededByExisting,
      deduplicated: outcome.deduplicated,
    }));
    return 0;
  }
  if (options.command === 'claim') {
    const entry = claimNext(queue, options);
    const saved = writeQueue(options.file, queue);
    console.log(JSON.stringify({
      ok: true,
      claimed: Boolean(entry),
      entry,
      remaining: saved.entries.filter(candidate => candidate.status === 'pending').length,
    }));
    return entry ? 0 : 75;
  }
  if (options.command === 'complete') {
    const completed = completeClaim(queue, options);
    const saved = writeQueue(options.file, queue);
    console.log(JSON.stringify({ok: true, completed, ...statusPayload(saved, options.file)}));
    return 0;
  }
  if (options.command === 'fail') {
    failClaim(queue, options);
    const saved = writeQueue(options.file, queue);
    console.log(JSON.stringify(statusPayload(saved, options.file)));
    return 0;
  }
  recoverExpired(queue, Date.now());
  const saved = writeQueue(options.file, queue);
  console.log(JSON.stringify(statusPayload(saved, options.file)));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      errorCode: String(error?.message || 'QUEUE_FAILED').slice(0, 120),
    }));
    process.exitCode = 1;
  }
}
