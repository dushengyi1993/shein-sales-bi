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

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  manage_bi_portal_section_queue.mjs enqueue --sections CSV [--priority N] [--reason TEXT] [--file PATH]
  manage_bi_portal_section_queue.mjs claim [--lease-seconds N] [--file PATH]
  manage_bi_portal_section_queue.mjs complete --section NAME --lease-id ID [--file PATH]
  manage_bi_portal_section_queue.mjs fail --section NAME --lease-id ID [--error TEXT] [--backoff-seconds N] [--file PATH]
  manage_bi_portal_section_queue.mjs status [--file PATH]`);
  return 64;
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
    priority: 50,
    reason: '',
    section: '',
    leaseId: undefined,
    leaseSeconds: 2_700,
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
    else if (token === '--section') options.section = normalizeSection(next());
    else if (token === '--lease-id') options.leaseId = next();
    else if (token === '--lease-seconds') options.leaseSeconds = Number(next());
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
  now = new Date(),
} = {}) {
  const nowIso = now.toISOString();
  let nextSequence = Number.isSafeInteger(queue.nextSequence) && queue.nextSequence >= 0
    ? queue.nextSequence
    : 0;
  for (const entry of queue.entries) {
    const sequence = Number(entry?.sequence || 0);
    if (Number.isSafeInteger(sequence) && sequence > nextSequence) nextSequence = sequence;
  }
  queue.nextSequence = nextSequence;
  for (const rawSection of sections || []) {
    const section = normalizeSection(rawSection);
    let entry = queue.entries.find(candidate => candidate.section === section);
    if (!entry) {
      queue.nextSequence += 1;
      entry = {
        section,
        sequence: queue.nextSequence,
        priority,
        requestRevision: 1,
        claimedRevision: 0,
        rerun: false,
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
    } else {
      entry.priority = Math.min(Number(entry.priority ?? priority), priority);
      entry.requestRevision = (Number(entry.requestRevision || 0) || 0) + 1;
      entry.updatedAt = nowIso;
      // An explicit new request supersedes failure backoff. The revision
      // guard still prevents an older running lease from completing it.
      entry.nextAttemptAt = '';
      // A re-enqueue while a lease is still running must not delete or split
      // the entry: keep the worker on the old revision, mark the rerun, and
      // let complete/fail reconcile the revision before the entry is free.
      if (entry.status === 'running') entry.rerun = true;
      if (entry.status !== 'running') entry.status = 'pending';
    }
    if (reason && !entry.reasons.includes(reason)) entry.reasons.push(reason.slice(0, 300));
  }
  return queue;
}

export function claimNext(queue, {
  leaseSeconds = 2_700,
  now = new Date(),
  leaseId = crypto.randomUUID(),
} = {}) {
  const nowMillis = now.getTime();
  recoverExpired(queue, nowMillis);
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
    entry.lastError = `complete superseded by requestRevision=${Number(entry.requestRevision)}`;
    entry.updatedAt = now.toISOString();
    return false;
  }
  queue.entries.splice(index, 1);
  return true;
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
    enqueueSections(queue, options);
    const saved = writeQueue(options.file, queue);
    console.log(JSON.stringify(statusPayload(saved, options.file)));
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
