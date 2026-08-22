#!/usr/bin/env node

import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
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
const PUBLISHED_SNAPSHOT_MAX_ENTRIES = 2_048;
const PUBLISHED_SNAPSHOT_MAX_AGE_MS = COMPLETED_LEDGER_MAX_AGE_MS;
const CORE_GENERATED_AT_PATTERN = /^[\x21-\x7E]{1,1024}$/;
const GENERATION_COMPLETION_VERSION = 1;
const GENERATION_COMPLETION_SECTION_COUNT = 7;
const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TERMINAL_ROOT = path.join(SOURCE_ROOT, 'outputs', 'bi-portal');
const DEFAULT_TERMINAL_VALIDATOR = process.env.SHEIN_BI_TERMINAL_VALIDATOR
  || path.join(SOURCE_ROOT, 'scripts', 'check_bi_portal_section_terminal.mjs');

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  manage_bi_portal_section_queue.mjs enqueue --sections CSV --core-generated-at TOKEN [--priority N] [--reason TEXT] [--idempotency-key KEY] [--coalesce-key KEY] [--requeue-completed-sections CSV] [--file PATH]
  manage_bi_portal_section_queue.mjs reconcile-generation --phase snapshot|validate|commit --sections CSV --core-generated-at TOKEN [--snapshot-hash SHA256] [--validation-result BASE64URL] [--terminal-root PATH] [--terminal-validator PATH] [--file PATH]
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

function validateCoreGeneratedAt(value) {
  const generatedAt = String(value || '').trim();
  if (!generatedAt) return '';
  if (!CORE_GENERATED_AT_PATTERN.test(generatedAt)) throw new TypeError('QUEUE_CORE_GENERATED_AT_INVALID');
  return generatedAt;
}

function normalizeSection(value) {
  const section = String(value || '').trim();
  if (!SECTION_PATTERN.test(section)) throw new TypeError(`SECTION_INVALID_${section}`);
  return section;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!['enqueue', 'reconcile-generation', 'claim', 'complete', 'fail', 'status'].includes(command)) {
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
    coalesceKey: '',
    coreGeneratedAt: '',
    terminalRoot: DEFAULT_TERMINAL_ROOT,
    terminalValidator: DEFAULT_TERMINAL_VALIDATOR,
    phase: '',
    snapshotHash: '',
    validationResult: '',
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
    else if (token === '--coalesce-key') options.coalesceKey = validateIdempotencyKey(next());
    else if (token === '--core-generated-at') options.coreGeneratedAt = validateCoreGeneratedAt(next());
    else if (token === '--terminal-root') options.terminalRoot = path.resolve(next());
    else if (token === '--terminal-validator') options.terminalValidator = path.resolve(next());
    else if (token === '--phase') options.phase = next();
    else if (token === '--snapshot-hash') options.snapshotHash = next();
    else if (token === '--validation-result') options.validationResult = next();
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
  if (command === 'enqueue' && !options.coreGeneratedAt) throw new TypeError('QUEUE_CORE_GENERATED_AT_REQUIRED');
  if (command === 'reconcile-generation') {
    const uniqueSections = new Set(options.sections);
    if (!options.coreGeneratedAt) throw new TypeError('QUEUE_CORE_GENERATED_AT_REQUIRED');
    if (options.sections.length !== GENERATION_COMPLETION_SECTION_COUNT
      || uniqueSections.size !== GENERATION_COMPLETION_SECTION_COUNT) {
      throw new TypeError('QUEUE_GENERATION_COMPLETION_SECTIONS_INVALID');
    }
    if (!['snapshot', 'validate', 'commit'].includes(options.phase)) {
      throw new TypeError('QUEUE_RECONCILE_PHASE_INVALID');
    }
    if (['validate', 'commit'].includes(options.phase)
      && !/^[a-f0-9]{64}$/u.test(options.snapshotHash)) {
      throw new TypeError('QUEUE_RECONCILE_SNAPSHOT_HASH_INVALID');
    }
    if (options.phase === 'commit' && !/^[A-Za-z0-9_-]{1,32768}$/u.test(options.validationResult)) {
      throw new TypeError('QUEUE_RECONCILE_VALIDATION_RESULT_INVALID');
    }
  }
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
    nextIntentRevision: 0,
    sectionIntentRevisions: {},
    entries: [],
    completedIdempotency: [],
    publishedSnapshots: [],
    generationCompletion: null,
  };
}

function normalizeRevision(value, fallback = 0) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : fallback;
}

function normalizePublishedSnapshot(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const section = String(record.section || '');
  const publishedRevision = normalizeRevision(record.publishedRevision ?? record.revision, 0);
  const publishedAt = String(record.publishedAt || record.completedAt || '');
  if (!SECTION_PATTERN.test(section) || publishedRevision <= 0 || !publishedAt) return null;
  return {
    section,
    publishedRevision,
    coreGeneratedAt: validateCoreGeneratedAt(record.coreGeneratedAt) || 'unknown',
    publishedAt,
    ...(typeof record.idempotencyKey === 'string' && record.idempotencyKey
      ? {idempotencyKey: record.idempotencyKey}
      : {}),
  };
}

function latestPublishedBySection(queue) {
  const latest = new Map();
  const consider = record => {
    const normalized = normalizePublishedSnapshot(record);
    if (!normalized) return;
    const prior = latest.get(normalized.section);
    const normalizedAt = Date.parse(normalized.publishedAt);
    const priorAt = Date.parse(String(prior?.publishedAt || ''));
    const bothTimestampsInvalid = !Number.isFinite(normalizedAt) && !Number.isFinite(priorAt);
    if (!prior
      || (Number.isFinite(normalizedAt) && (!Number.isFinite(priorAt) || normalizedAt > priorAt))
      || ((normalizedAt === priorAt || bothTimestampsInvalid)
        && normalized.publishedRevision >= prior.publishedRevision)) {
      latest.set(normalized.section, normalized);
    }
  };
  for (const record of Array.isArray(queue?.publishedSnapshots) ? queue.publishedSnapshots : []) consider(record);
  // A completed keyed request is also a published snapshot. This fallback
  // keeps status truthful for queues written by an older manager that did not
  // yet have the dedicated snapshot ledger.
  for (const record of Array.isArray(queue?.completedIdempotency) ? queue.completedIdempotency : []) consider({
    ...record,
    publishedRevision: record?.publishedRevision,
    publishedAt: record?.publishedAt || record?.completedAt,
  });
  return latest;
}

function trimPublishedSnapshots(queue, now = new Date()) {
  const nowMillis = now.getTime();
  const records = Array.isArray(queue.publishedSnapshots) ? queue.publishedSnapshots : [];
  const current = records
    .map(normalizePublishedSnapshot)
    .filter(record => record && (() => {
      const publishedAt = Date.parse(record.publishedAt);
      return Number.isFinite(publishedAt) && nowMillis - publishedAt <= PUBLISHED_SNAPSHOT_MAX_AGE_MS;
    })())
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  queue.publishedSnapshots = current.slice(0, PUBLISHED_SNAPSHOT_MAX_ENTRIES);
  return queue.publishedSnapshots.length !== records.length;
}

// Old queue.json files predate sequence/requestRevision/claimedRevision/
// nextAttemptAt. Normalize deterministically on every read so legacy entries
// keep working and repeated reads of the same file stay stable.
function normalizeQueue(queue) {
  queue.entries = Array.isArray(queue.entries) ? queue.entries : [];
  queue.completedIdempotency = Array.isArray(queue.completedIdempotency)
    ? queue.completedIdempotency
      .map(record => ({
        ...record,
        publishedRevision: normalizeRevision(record?.publishedRevision, 0),
        publishedAt: String(record?.publishedAt || record?.completedAt || ''),
        coreGeneratedAt: validateCoreGeneratedAt(record?.coreGeneratedAt) || 'unknown',
      }))
      .filter(record => typeof record.idempotencyKey === 'string' && record.idempotencyKey)
    : [];
  queue.publishedSnapshots = (Array.isArray(queue.publishedSnapshots) ? queue.publishedSnapshots : [])
    .map(normalizePublishedSnapshot)
    .filter(Boolean);
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
    entry.claimedIdempotencyKey = typeof entry.claimedIdempotencyKey === 'string'
      ? entry.claimedIdempotencyKey
      : '';
    entry.claimedCoreGeneratedAt = validateCoreGeneratedAt(entry.claimedCoreGeneratedAt) || '';
    entry.lastPublishedRevision = normalizeRevision(entry.lastPublishedRevision, 0);
    entry.lastPublishedAt = typeof entry.lastPublishedAt === 'string' ? entry.lastPublishedAt : '';
    entry.nextAttemptAt = typeof entry.nextAttemptAt === 'string' ? entry.nextAttemptAt : '';
    entry.rerun = Boolean(entry.rerun);
    const rerunPriority = Number(entry.rerunPriority ?? NaN);
    entry.rerunPriority = Number.isSafeInteger(rerunPriority) && rerunPriority >= 0 ? rerunPriority : null;
    entry.dependencyYield = Boolean(entry.dependencyYield);
    if (Object.prototype.hasOwnProperty.call(entry, 'idempotencyKey')) {
      entry.idempotencyKey = typeof entry.idempotencyKey === 'string' ? entry.idempotencyKey : '';
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'coalesceKey')) {
      entry.coalesceKey = typeof entry.coalesceKey === 'string' ? entry.coalesceKey : '';
    }
    entry.coreGeneratedAt = validateCoreGeneratedAt(entry.coreGeneratedAt) || 'unknown';
    const priority = Number(entry.priority ?? 50);
    entry.priority = Number.isSafeInteger(priority) && priority >= 0 ? priority : 50;
    if (!['pending', 'running'].includes(entry.status)) entry.status = 'pending';
    if (entry.status === 'running') {
      if (!entry.claimedIdempotencyKey) entry.claimedIdempotencyKey = entry.idempotencyKey;
      if (!entry.claimedCoreGeneratedAt) entry.claimedCoreGeneratedAt = entry.coreGeneratedAt;
    }
  }
  queue.nextSequence = nextSequence;
  const revisions = queue.sectionIntentRevisions && typeof queue.sectionIntentRevisions === 'object'
    && !Array.isArray(queue.sectionIntentRevisions)
    ? queue.sectionIntentRevisions
    : {};
  queue.sectionIntentRevisions = {};
  let nextIntentRevision = Number.isSafeInteger(Number(queue.nextIntentRevision))
    && Number(queue.nextIntentRevision) >= 0
    ? Number(queue.nextIntentRevision)
    : 0;
  for (const [section, rawRevision] of Object.entries(revisions)) {
    if (!SECTION_PATTERN.test(section)) continue;
    const revision = Number(rawRevision);
    if (!Number.isSafeInteger(revision) || revision < 0) continue;
    queue.sectionIntentRevisions[section] = revision;
    nextIntentRevision = Math.max(nextIntentRevision, revision);
  }
  queue.nextIntentRevision = nextIntentRevision;
  if (!queue.generationCompletion || typeof queue.generationCompletion !== 'object' || Array.isArray(queue.generationCompletion)) {
    queue.generationCompletion = null;
  }
  return queue;
}

function readQueue(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeQueue({
      version: 1,
      updatedAt: String(value?.updatedAt || ''),
      nextSequence: Number(value?.nextSequence || 0),
      nextIntentRevision: Number(value?.nextIntentRevision || 0),
      sectionIntentRevisions: value?.sectionIntentRevisions || {},
      entries: Array.isArray(value?.entries) ? value.entries : [],
      completedIdempotency: Array.isArray(value?.completedIdempotency)
        ? value.completedIdempotency.map(record => ({
          ...record,
          publishedRevision: normalizeRevision(record?.publishedRevision, 0),
          publishedAt: String(record?.publishedAt || record?.completedAt || ''),
          coreGeneratedAt: validateCoreGeneratedAt(record?.coreGeneratedAt) || 'unknown',
        }))
        : [],
      publishedSnapshots: Array.isArray(value?.publishedSnapshots) ? value.publishedSnapshots : [],
      generationCompletion: value?.generationCompletion || null,
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

function ensureQueueState(queue) {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) {
    throw new TypeError('QUEUE_STATE_INVALID');
  }
  return normalizeQueue(queue);
}

function recordPublishedSnapshot(queue, entry, now = new Date()) {
  const claimedRevision = normalizeRevision(entry?.claimedRevision, 0);
  if (claimedRevision <= 0) return null;
  const publishedAt = now.toISOString();
  const snapshot = {
    section: entry.section,
    publishedRevision: claimedRevision,
    coreGeneratedAt: entry.coreGeneratedAt || 'unknown',
    publishedAt,
    ...(entry.idempotencyKey ? {idempotencyKey: entry.idempotencyKey} : {}),
  };
  const existingSnapshot = queue.publishedSnapshots.find(record => (
    record.section === snapshot.section
      && Number(record.publishedRevision) === snapshot.publishedRevision
      && String(record.coreGeneratedAt || '') === snapshot.coreGeneratedAt
  ));
  if (existingSnapshot) {
    existingSnapshot.publishedAt = publishedAt;
    if (snapshot.idempotencyKey) existingSnapshot.idempotencyKey = snapshot.idempotencyKey;
  } else {
    queue.publishedSnapshots.push(snapshot);
  }

  // Keep the durable keyed idempotency tombstone for every successful claim,
  // including a claim that leaves one newer revision pending. The old request
  // really did publish; only its follow-up remains outstanding.
  if (entry.idempotencyKey) {
    const existingCompletion = queue.completedIdempotency.find(record => (
      record.idempotencyKey === entry.idempotencyKey
    ));
    if (!existingCompletion) {
      queue.completedIdempotency.push({
        idempotencyKey: entry.idempotencyKey,
        section: entry.section,
        publishedRevision: claimedRevision,
        publishedAt,
        coreGeneratedAt: entry.coreGeneratedAt || 'unknown',
        completedAt: now.toISOString(),
      });
    }
    trimCompletedIdempotency(queue, now);
  }
  trimPublishedSnapshots(queue, now);
  return snapshot;
}

function recoverExpired(queue, nowMillis) {
  for (const entry of queue.entries) {
    if (entry.status !== 'running') continue;
    const expiresAt = Date.parse(entry.leaseExpiresAt || '');
    if (!entry.leaseId || Number.isNaN(expiresAt) || expiresAt <= nowMillis) {
      entry.status = 'pending';
      entry.leaseId = '';
      entry.leaseExpiresAt = '';
      entry.claimedRevision = 0;
      entry.claimedIdempotencyKey = '';
      entry.claimedCoreGeneratedAt = '';
      entry.lastError = entry.lastError || 'worker lease expired';
    }
  }
}

function generationCompletionSections(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
  if (!Array.isArray(receipt.sections)) return [];
  return [...new Set(receipt.sections.map(value => String(value || '').trim()).filter(Boolean))];
}

function invalidateGenerationCompletion(queue, sections) {
  if (!queue.generationCompletion || typeof queue.generationCompletion !== 'object') return false;
  const receiptSections = new Set(generationCompletionSections(queue.generationCompletion));
  if (!receiptSections.size) {
    queue.generationCompletion = null;
    return true;
  }
  const intersects = (sections || []).some(section => receiptSections.has(String(section || '')));
  if (!intersects) return false;
  queue.generationCompletion = null;
  return true;
}

function recordEnqueueIntent(queue, sections) {
  queue.sectionIntentRevisions = queue.sectionIntentRevisions
    && typeof queue.sectionIntentRevisions === 'object'
    && !Array.isArray(queue.sectionIntentRevisions)
    ? queue.sectionIntentRevisions
    : {};
  let revision = Number.isSafeInteger(Number(queue.nextIntentRevision))
    && Number(queue.nextIntentRevision) >= 0
    ? Number(queue.nextIntentRevision)
    : 0;
  for (const section of [...new Set((sections || []).map(normalizeSection))]) {
    revision += 1;
    queue.sectionIntentRevisions[section] = revision;
  }
  queue.nextIntentRevision = revision;
}

export function enqueueSections(queue, {
  sections,
  priority = 50,
  reason = '',
  idempotencyKey = '',
  coalesceKey = '',
  coreGeneratedAt = '',
  requeueCompletedSections = [],
  now = new Date(),
} = {}) {
  ensureQueueState(queue);
  const nowIso = now.toISOString();
  const key = validateIdempotencyKey(idempotencyKey);
  const groupKey = validateIdempotencyKey(coalesceKey);
  const generation = validateCoreGeneratedAt(coreGeneratedAt);
  if (!generation) throw new TypeError('QUEUE_CORE_GENERATED_AT_REQUIRED');
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
  // Every enqueue call is an intent, including a completed-key replay. Record
  // a durable per-section revision and invalidate a matching completion
  // receipt before any deduplication return. Optimistic reconciliation uses
  // these revisions to detect an enqueue that landed during artifact checks.
  recordEnqueueIntent(queue, [...requestedSet]);
  mutated = true;
  const invalidatedByIntent = invalidateGenerationCompletion(queue, [...requestedSet]);
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
    retiredLegacyCompleted: [],
    supersededByExisting: [],
    invalidatedGenerationCompletion: invalidatedByIntent,
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
    if (requeueSet.has(section) && entry
      && (entry.coreGeneratedAt !== generation
        || (entryKey && entry.idempotencyKey && entry.idempotencyKey !== entryKey))) {
      outcome.supersededByExisting.push(section);
      continue;
    }
    // A narrow requeue of invalid completed sections: under the same lock and
    // mutation, remove ONLY the matching ${key}::section tombstones for the
    // listed sections so the normal enqueue below recreates their entries;
    // valid tombstones stay untouched.  No manual deletes.
    if (requeueSet.has(section) && entryKey && Array.isArray(queue.completedIdempotency)) {
      const before = queue.completedIdempotency.length;
      queue.completedIdempotency = queue.completedIdempotency.filter(record => (
        record.idempotencyKey !== entryKey || record.coreGeneratedAt !== generation
      ));
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
    let matchingCompleted = entryKey && Array.isArray(queue.completedIdempotency)
      ? queue.completedIdempotency.find(record => record.idempotencyKey === entryKey)
      : null;
    if (matchingCompleted && matchingCompleted.coreGeneratedAt === 'unknown') {
      // A pre-generation tombstone is not evidence for any current core. An
      // explicit generation request with the exact compatible key retires it
      // under the same lock and creates fresh work; it is never promoted into
      // a current-generation completion receipt.
      queue.completedIdempotency = queue.completedIdempotency.filter(record => !(
        record.idempotencyKey === entryKey
          && String(record.section || '') === section
          && record.coreGeneratedAt === 'unknown'
      ));
      outcome.retiredLegacyCompleted.push(section);
      matchingCompleted = null;
      mutated = true;
    }
    if (matchingCompleted && matchingCompleted.coreGeneratedAt !== generation) {
      throw new Error('QUEUE_IDEMPOTENCY_GENERATION_CONFLICT');
    }
    if (matchingCompleted) {
      outcome.deduplicatedCompleted.push(section);
      continue;
    }
    // Durable per-section idempotency: an existing pending/running entry with
    // the exact same key is a strict no-op (no revision bump, no rerun, no
    // lease/backoff reset).
    if (entry && entryKey && entry.idempotencyKey === entryKey
      && entry.coreGeneratedAt !== generation) {
      throw new Error('QUEUE_IDEMPOTENCY_GENERATION_CONFLICT');
    }
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
        claimedIdempotencyKey: '',
        claimedCoreGeneratedAt: '',
        lastPublishedRevision: 0,
        lastPublishedAt: '',
        rerun: false,
        rerunPriority: null,
        dependencyYield: false,
        ...(entryKey ? {idempotencyKey: entryKey} : {}),
        ...(groupKey ? {coalesceKey: groupKey} : {}),
        coreGeneratedAt: generation,
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
      const sameCoalesceGroup = Boolean(
        groupKey && entry.coalesceKey === groupKey && entry.coreGeneratedAt === generation,
      );
      // A pending build has not taken its database snapshot yet, so every
      // event in the same generation/group is already covered by that future
      // build. Do not turn a steady webhook stream into an unbounded numeric
      // revision chase. A running build still receives exactly one rerun
      // below, because an event may land after its snapshot was taken.
      if (sameCoalesceGroup && entry.status === 'pending') {
        const nextPriority = Math.min(Number(entry.priority ?? priority), priority);
        if (nextPriority !== entry.priority) {
          entry.priority = nextPriority;
          mutated = true;
        }
        if (reason && !entry.reasons.includes(reason.slice(0, 300))) {
          entry.reasons.push(reason.slice(0, 300));
          mutated = true;
        }
        outcome.deduplicatedPending.push(section);
        continue;
      }
      // Once a running build already owns one coalesced rerun, further events
      // in the same group are covered by that rerun. Preserve the current
      // idempotency key/revision so completion can make progress.
      if (sameCoalesceGroup && entry.status === 'running' && entry.rerun === true) {
        const nextRerunPriority = entry.rerunPriority == null
          ? priority
          : Math.min(Number(entry.rerunPriority), priority);
        if (nextRerunPriority !== entry.rerunPriority) {
          entry.rerunPriority = nextRerunPriority;
          mutated = true;
        }
        if (reason && !entry.reasons.includes(reason.slice(0, 300))) {
          entry.reasons.push(reason.slice(0, 300));
          mutated = true;
        }
        outcome.coalescedRerun.push(section);
        continue;
      }
      // A legacy entry without a key, or an entry bound to a different key,
      // keeps the old behavior; the entry adopts the new key so later
      // duplicates of this request deduplicate correctly.
      if (entryKey && entry.idempotencyKey !== entryKey) {
        entry.idempotencyKey = entryKey;
        mutated = true;
      }
      if (entry.coalesceKey !== groupKey) {
        entry.coalesceKey = groupKey;
        mutated = true;
      }
      if (entry.coreGeneratedAt !== generation) {
        entry.coreGeneratedAt = generation;
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
  ensureQueueState(queue);
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
  entry.claimedIdempotencyKey = entry.idempotencyKey || '';
  entry.claimedCoreGeneratedAt = entry.coreGeneratedAt || 'unknown';
  entry.rerun = false;
  entry.dependencyYield = false;
  entry.updatedAt = now.toISOString();
  return {
    ...entry,
    desiredRevision: Number(entry.requestRevision || 0),
    lastPublishedRevision: Number(entry.lastPublishedRevision || 0),
  };
}

export function completeClaim(queue, {section, leaseId, now = new Date()} = {}) {
  ensureQueueState(queue);
  const normalizedSection = normalizeSection(section);
  const index = queue.entries.findIndex(entry => entry.section === normalizedSection);
  if (index < 0) return false;
  const entry = queue.entries[index];
  if (entry.status !== 'running' || entry.leaseId !== leaseId) {
    throw new Error('QUEUE_LEASE_MISMATCH');
  }
  const claimedRevision = normalizeRevision(entry.claimedRevision, 0);
  const desiredRevision = normalizeRevision(entry.requestRevision, 0);
  // The entry may adopt a newer request's key/generation while this lease is
  // running. Bind the publication evidence to the immutable claim fields.
  const claimedEntry = {
    ...entry,
    idempotencyKey: entry.claimedIdempotencyKey || entry.idempotencyKey || '',
    coreGeneratedAt: entry.claimedCoreGeneratedAt || entry.coreGeneratedAt || 'unknown',
  };
  const publishedSnapshot = recordPublishedSnapshot(queue, claimedEntry, now);
  if (publishedSnapshot) {
    entry.lastPublishedRevision = Math.max(
      normalizeRevision(entry.lastPublishedRevision, 0),
      claimedRevision,
    );
    entry.lastPublishedAt = publishedSnapshot.publishedAt;
  }
  if (desiredRevision > claimedRevision) {
    // The entry was re-enqueued while this lease ran. The claimed revision has
    // already produced a safe terminal artifact, so publish that snapshot and
    // retain exactly this one queue entry for the newer desired revision.
    // Never describe the successful claim as "complete superseded": doing so
    // loses the dependency-safe publication and can livelock profit behind a
    // continuous event stream.
    entry.status = 'pending';
    entry.leaseId = '';
    entry.leaseExpiresAt = '';
    // The successful claim no longer owns an active lease. Keep its durable
    // publication in lastPublishedRevision/publishedSnapshots, but clear the
    // claim identity so status/health cannot report a stale in-flight claim
    // while the newer revision waits for its follow-up run.
    entry.claimedRevision = 0;
    entry.claimedIdempotencyKey = '';
    entry.claimedCoreGeneratedAt = '';
    entry.nextAttemptAt = '';
    entry.dependencyYield = entry.section === 'profit';
    if (Number.isSafeInteger(Number(entry.rerunPriority))) entry.priority = Number(entry.rerunPriority);
    entry.rerunPriority = null;
    entry.rerun = false;
    queue.nextSequence = Math.max(Number(queue.nextSequence || 0), ...queue.entries.map(item => Number(item.sequence || 0))) + 1;
    entry.sequence = queue.nextSequence;
    entry.lastError = '';
    entry.updatedAt = now.toISOString();
    return true;
  }
  queue.entries.splice(index, 1);
  // recordPublishedSnapshot already wrote the keyed tombstone and durable
  // publication ledger before the entry was removed. It intentionally uses
  // claimedCoreGeneratedAt/claimedIdempotencyKey, not a later request's fields.
  return Boolean(publishedSnapshot || claimedRevision > 0);
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

function runTerminalValidator({terminalValidator, terminalRoot, section, coreGeneratedAt}) {
  const result = spawnSync(process.execPath, [
    terminalValidator,
    '--root', terminalRoot,
    '--section', section,
    '--expected-generated-at', coreGeneratedAt,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  let report = null;
  try {
    const output = String(result.stdout || '').trim().split(/\r?\n/u).filter(Boolean).at(-1) || '';
    report = output ? JSON.parse(output) : null;
  } catch {
    report = null;
  }
  return {
    ok: result.status === 0
      && report?.ok === true
      && report?.section === section
      && report?.coreGeneratedAt === coreGeneratedAt
      && report?.sectionGeneratedAt === coreGeneratedAt,
    section,
    reason: String(report?.reason || result.error?.code || `validator_exit_${result.status ?? 'unknown'}`),
  };
}

function sameSectionSet(left, right) {
  const leftSections = [...new Set((left || []).map(value => String(value || '')).filter(Boolean))].sort();
  const rightSections = [...new Set((right || []).map(value => String(value || '')).filter(Boolean))].sort();
  return leftSections.length === rightSections.length
    && leftSections.every((section, index) => section === rightSections[index]);
}

function generationReconcileRequest({sections, coreGeneratedAt} = {}) {
  const generation = validateCoreGeneratedAt(coreGeneratedAt);
  if (!generation) throw new TypeError('QUEUE_CORE_GENERATED_AT_REQUIRED');
  const requestedSections = [...new Set((sections || []).map(normalizeSection))];
  if (requestedSections.length !== GENERATION_COMPLETION_SECTION_COUNT) {
    throw new TypeError('QUEUE_GENERATION_COMPLETION_SECTIONS_INVALID');
  }
  return {generation, requestedSections};
}

function generationSnapshotHash(queue, generation, requestedSections) {
  const requestedSet = new Set(requestedSections);
  const entries = queue.entries
    .filter(entry => requestedSet.has(String(entry?.section || '')))
    .map(entry => ({
      section: entry.section,
      sequence: entry.sequence,
      status: entry.status,
      requestRevision: entry.requestRevision,
      claimedRevision: entry.claimedRevision,
      lastPublishedRevision: entry.lastPublishedRevision,
      rerun: entry.rerun,
      idempotencyKey: entry.idempotencyKey || '',
      coreGeneratedAt: entry.coreGeneratedAt || 'unknown',
    }))
    .sort((left, right) => left.section.localeCompare(right.section) || left.sequence - right.sequence);
  const completedIdempotency = (queue.completedIdempotency || [])
    .filter(record => requestedSet.has(String(record?.section || '')))
    .map(record => ({
      section: String(record.section || ''),
      idempotencyKey: String(record.idempotencyKey || ''),
      coreGeneratedAt: String(record.coreGeneratedAt || 'unknown'),
      publishedRevision: normalizeRevision(record.publishedRevision, 0),
      completedAt: String(record.completedAt || ''),
    }))
    .sort((left, right) => (
      left.section.localeCompare(right.section)
        || left.idempotencyKey.localeCompare(right.idempotencyKey)
        || left.completedAt.localeCompare(right.completedAt)
    ));
  return crypto.createHash('sha256').update(JSON.stringify({
    coreGeneratedAt: generation,
    sections: requestedSections,
    sectionIntentRevisions: requestedSections.map(section => [
      section,
      Number(queue.sectionIntentRevisions?.[section] || 0),
    ]),
    entries,
    completedIdempotency,
    publishedSnapshots: (queue.publishedSnapshots || [])
      .filter(record => requestedSet.has(String(record?.section || '')))
      .map(record => ({
        section: String(record.section || ''),
        publishedRevision: normalizeRevision(record.publishedRevision, 0),
        coreGeneratedAt: String(record.coreGeneratedAt || 'unknown'),
        publishedAt: String(record.publishedAt || ''),
      }))
      .sort((left, right) => (
        left.section.localeCompare(right.section)
          || left.publishedRevision - right.publishedRevision
          || left.publishedAt.localeCompare(right.publishedAt)
      )),
    generationCompletion: queue.generationCompletion || null,
  })).digest('hex');
}

export function snapshotGenerationCompletion(queue, {
  sections,
  coreGeneratedAt,
  now = new Date(),
} = {}) {
  ensureQueueState(queue);
  const {generation, requestedSections} = generationReconcileRequest({sections, coreGeneratedAt});

  let mutated = trimCompletedIdempotency(queue, now);
  const requestedSet = new Set(requestedSections);
  const activeEntries = queue.entries.filter(entry => (
    requestedSet.has(String(entry?.section || ''))
      && ['pending', 'running'].includes(String(entry?.status || ''))
  ));
  const activeSections = [...new Set(activeEntries.map(entry => entry.section))].sort();
  const newerRevisionSections = [...new Set(activeEntries
    .filter(entry => entry.status === 'running' && (
      entry.rerun === true
      || !Number.isSafeInteger(Number(entry.requestRevision))
      || !Number.isSafeInteger(Number(entry.claimedRevision))
      || Number(entry.requestRevision) > Number(entry.claimedRevision)
    ))
    .map(entry => entry.section))].sort();
  const conflictingGenerationSections = [...new Set(activeEntries
    .filter(entry => entry.coreGeneratedAt !== generation)
    .map(entry => entry.section))].sort();
  if (activeEntries.length) {
    const invalidatedGenerationCompletion = invalidateGenerationCompletion(queue, activeSections);
    mutated ||= invalidatedGenerationCompletion;
    return {
      queue,
      mutated,
      completed: false,
      reason: 'queue-active',
      coreGeneratedAt: generation,
      activeSections,
      newerRevisionSections,
      conflictingGenerationSections,
      invalidatedGenerationCompletion,
    };
  }

  const completedBySection = new Map();
  for (const record of queue.completedIdempotency || []) {
    const section = String(record?.section || '');
    if (!requestedSet.has(section)) continue;
    const prior = completedBySection.get(section);
    if (!prior || Date.parse(String(record?.completedAt || '')) > Date.parse(String(prior?.completedAt || ''))) {
      completedBySection.set(section, record);
    }
  }
  const missingCompletedSections = requestedSections.filter(section => !completedBySection.has(section));
  const conflictingCompletedSections = requestedSections.filter(section => (
    completedBySection.has(section)
      && completedBySection.get(section)?.coreGeneratedAt !== generation
  ));
  if (missingCompletedSections.length || conflictingCompletedSections.length) {
    const invalidatedGenerationCompletion = invalidateGenerationCompletion(queue, requestedSections);
    mutated ||= invalidatedGenerationCompletion;
    return {
      queue,
      mutated,
      completed: false,
      reason: 'terminal-receipt-missing',
      coreGeneratedAt: generation,
      missingCompletedSections,
      conflictingCompletedSections,
      invalidatedGenerationCompletion,
    };
  }

  return {
    queue,
    mutated,
    completed: false,
    readyForValidation: true,
    reason: 'terminal-validation-required',
    coreGeneratedAt: generation,
    snapshotHash: generationSnapshotHash(queue, generation, requestedSections),
  };
}

export function validateGenerationSnapshot({
  sections,
  coreGeneratedAt,
  snapshotHash,
  terminalRoot = DEFAULT_TERMINAL_ROOT,
  terminalValidator = DEFAULT_TERMINAL_VALIDATOR,
  validateTerminal = null,
} = {}) {
  const {generation, requestedSections} = generationReconcileRequest({sections, coreGeneratedAt});
  if (!/^[a-f0-9]{64}$/u.test(String(snapshotHash || ''))) {
    throw new TypeError('QUEUE_RECONCILE_SNAPSHOT_HASH_INVALID');
  }

  const terminalResults = requestedSections.map(section => {
    if (typeof validateTerminal === 'function') {
      const result = validateTerminal({
        terminalValidator,
        terminalRoot,
        section,
        coreGeneratedAt: generation,
      });
      return typeof result === 'object' && result !== null
        ? {section, ...result, ok: result.ok === true}
        : {section, ok: result === true, reason: result === true ? '' : 'terminal_mismatch'};
    }
    return runTerminalValidator({terminalValidator, terminalRoot, section, coreGeneratedAt: generation});
  });
  const invalidTerminalSections = terminalResults.filter(result => !result.ok).map(result => result.section);
  const validationPayload = {
    version: 1,
    snapshotHash,
    coreGeneratedAt: generation,
    sections: requestedSections,
    terminalResults: terminalResults.map(result => ({
      section: result.section,
      ok: result.ok === true,
      reason: String(result.reason || '').slice(0, 300),
    })),
  };
  return {
    completed: false,
    validated: invalidTerminalSections.length === 0,
    reason: invalidTerminalSections.length ? 'terminal-mismatch' : 'terminal-validation-passed',
    coreGeneratedAt: generation,
    snapshotHash,
    invalidTerminalSections,
    terminalResults,
    validationResult: Buffer.from(JSON.stringify(validationPayload), 'utf8').toString('base64url'),
  };
}

function parseGenerationValidationResult(encoded, generation, requestedSections, snapshotHash) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(encoded || ''), 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('QUEUE_RECONCILE_VALIDATION_RESULT_INVALID');
  }
  const terminalResults = Array.isArray(payload?.terminalResults) ? payload.terminalResults : [];
  if (payload?.version !== 1
    || payload?.snapshotHash !== snapshotHash
    || payload?.coreGeneratedAt !== generation
    || !sameSectionSet(payload?.sections, requestedSections)
    || terminalResults.length !== requestedSections.length
    || !sameSectionSet(terminalResults.map(result => result?.section), requestedSections)) {
    throw new TypeError('QUEUE_RECONCILE_VALIDATION_RESULT_INVALID');
  }
  return terminalResults.map(result => ({
    section: String(result.section || ''),
    ok: result.ok === true,
    reason: String(result.reason || '').slice(0, 300),
  }));
}

export function commitGenerationCompletion(queue, {
  sections,
  coreGeneratedAt,
  snapshotHash,
  validationResult,
  now = new Date(),
} = {}) {
  const {generation, requestedSections} = generationReconcileRequest({sections, coreGeneratedAt});
  const terminalResults = parseGenerationValidationResult(
    validationResult,
    generation,
    requestedSections,
    snapshotHash,
  );
  const current = snapshotGenerationCompletion(queue, {sections: requestedSections, coreGeneratedAt: generation, now});
  if (!current.readyForValidation) return current;
  if (current.snapshotHash !== snapshotHash) {
    const invalidatedGenerationCompletion = invalidateGenerationCompletion(queue, requestedSections);
    return {
      queue,
      mutated: current.mutated || invalidatedGenerationCompletion,
      completed: false,
      reason: 'snapshot-changed',
      coreGeneratedAt: generation,
      snapshotHash: current.snapshotHash,
      invalidatedGenerationCompletion,
    };
  }
  const invalidTerminalSections = terminalResults.filter(result => !result.ok).map(result => result.section);
  if (invalidTerminalSections.length) {
    const invalidatedGenerationCompletion = invalidateGenerationCompletion(queue, requestedSections);
    return {
      queue,
      mutated: current.mutated || invalidatedGenerationCompletion,
      completed: false,
      reason: 'terminal-mismatch',
      coreGeneratedAt: generation,
      invalidTerminalSections,
      terminalResults,
      invalidatedGenerationCompletion,
    };
  }

  const requestedSet = new Set(requestedSections);
  const completedBySection = new Map();
  for (const record of queue.completedIdempotency || []) {
    const section = String(record?.section || '');
    if (!requestedSet.has(section)) continue;
    const prior = completedBySection.get(section);
    if (!prior || Date.parse(String(record?.completedAt || '')) > Date.parse(String(prior?.completedAt || ''))) {
      completedBySection.set(section, record);
    }
  }
  const completionRecords = requestedSections.map(section => completedBySection.get(section));
  const evidenceHash = crypto.createHash('sha256').update(JSON.stringify({
    coreGeneratedAt: generation,
    sections: requestedSections,
    completedIdempotency: completionRecords.map(record => ({
      section: record.section,
      idempotencyKey: record.idempotencyKey,
      coreGeneratedAt: record.coreGeneratedAt,
      completedAt: record.completedAt,
    })),
  })).digest('hex');
  const existing = queue.generationCompletion;
  if (existing?.version === GENERATION_COMPLETION_VERSION
    && existing.coreGeneratedAt === generation
    && existing.evidenceHash === evidenceHash
    && sameSectionSet(existing.sections, requestedSections)) {
    return {
      queue,
      mutated: current.mutated,
      completed: true,
      reason: 'generation-completion-current',
      coreGeneratedAt: generation,
      generationCompletion: existing,
      terminalResults,
    };
  }
  queue.generationCompletion = {
    version: GENERATION_COMPLETION_VERSION,
    coreGeneratedAt: generation,
    sections: requestedSections,
    completedAt: now.toISOString(),
    evidenceHash,
    completedIdempotency: completionRecords.map(record => ({
      section: record.section,
      idempotencyKey: record.idempotencyKey,
      completedAt: record.completedAt,
    })),
  };
  return {
    queue,
    mutated: true,
    completed: true,
    reason: 'generation-completion-written',
    coreGeneratedAt: generation,
    generationCompletion: queue.generationCompletion,
    terminalResults,
  };
}

export function reconcileGenerationCompletion(queue, options = {}) {
  const snapshot = snapshotGenerationCompletion(queue, options);
  if (!snapshot.readyForValidation) return snapshot;
  const validation = validateGenerationSnapshot({...options, snapshotHash: snapshot.snapshotHash});
  return commitGenerationCompletion(queue, {
    ...options,
    snapshotHash: snapshot.snapshotHash,
    validationResult: validation.validationResult,
  });
}

export function failClaim(queue, {
  section,
  leaseId,
  error = '',
  now = new Date(),
  backoffSeconds = DEFAULT_FAIL_BACKOFF_SECONDS,
} = {}) {
  ensureQueueState(queue);
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
  // A failed lease is no longer active. The revision remains desired for a
  // retry, but its old claim identity must not be reported as in flight.
  entry.claimedRevision = 0;
  entry.claimedIdempotencyKey = '';
  entry.claimedCoreGeneratedAt = '';
  entry.dependencyYield = false;
  if (newerRevisionPending) {
    if (Number.isSafeInteger(Number(entry.rerunPriority))) entry.priority = Number(entry.rerunPriority);
    entry.rerunPriority = null;
    queue.nextSequence = Math.max(Number(queue.nextSequence || 0), ...queue.entries.map(item => Number(item.sequence || 0))) + 1;
    entry.sequence = queue.nextSequence;
  }
  entry.rerun = false;
  entry.lastError = String(error || 'section refresh failed').slice(0, 1_000);
  entry.updatedAt = now.toISOString();
  return true;
}

function statusPayload(queue, file) {
  ensureQueueState(queue);
  const counts = queue.entries.reduce((accumulator, entry) => {
    const status = String(entry.status || 'unknown');
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {});
  const latestPublished = latestPublishedBySection(queue);
  const lastPublishedRevisions = Object.fromEntries([...latestPublished.entries()]
    .map(([section, record]) => [section, Number(record.publishedRevision || 0)]));
  const lastPublishedAt = Object.fromEntries([...latestPublished.entries()]
    .map(([section, record]) => [section, String(record.publishedAt || '')]));
  const desiredRevisions = {};
  const healthSections = new Map();
  for (const [section, record] of latestPublished.entries()) {
    const lastPublishedRevision = Number(record.publishedRevision || 0);
    desiredRevisions[section] = lastPublishedRevision;
    healthSections.set(section, {
      section,
      status: 'published',
      requestRevision: lastPublishedRevision,
      desiredRevision: lastPublishedRevision,
      claimedRevision: 0,
      lastPublishedRevision,
      lastPublishedAt: String(record.publishedAt || ''),
      pendingFollowUp: false,
    });
  }
  const entries = queue.entries.map(entry => {
    // An active entry owns its revision epoch. A new core generation may start
    // at requestRevision=1 after an older generation published revision 2;
    // using the historical ledger's numeric maximum here would falsely mark
    // the new request as already published. completeClaim updates these
    // entry-local fields atomically with the publication ledger.
    const lastPublishedRevision = Number(entry.lastPublishedRevision || 0);
    const desiredRevision = Number(entry.requestRevision || 0);
    const lastPublishedAtForEntry = String(entry.lastPublishedAt || '');
    lastPublishedRevisions[entry.section] = lastPublishedRevision;
    lastPublishedAt[entry.section] = lastPublishedAtForEntry;
    desiredRevisions[entry.section] = desiredRevision;
    const pendingFollowUp = desiredRevision > lastPublishedRevision;
    healthSections.set(entry.section, {
      section: entry.section,
      status: entry.status,
      requestRevision: desiredRevision,
      desiredRevision,
      claimedRevision: Number(entry.claimedRevision || 0),
      lastPublishedRevision,
      lastPublishedAt: lastPublishedAtForEntry,
      pendingFollowUp,
    });
    return {
      ...entry,
      desiredRevision,
      lastPublishedRevision,
      pendingFollowUp,
    };
  });
  const sectionHealth = [...healthSections.values()].sort((left, right) => left.section.localeCompare(right.section));
  const health = {
    lastPublishedRevision: lastPublishedRevisions,
    lastPublishedRevisions,
    lastPublishedAt,
    desiredRevision: desiredRevisions,
    desiredRevisions,
    sections: sectionHealth,
  };
  return {
    ok: true,
    file,
    updatedAt: queue.updatedAt,
    counts,
    entries,
    lastPublishedRevision: lastPublishedRevisions,
    lastPublishedRevisions,
    lastPublishedAt,
    desiredRevision: desiredRevisions,
    desiredRevisions,
    publishedSnapshots: queue.publishedSnapshots,
    health,
    generationCompletion: queue.generationCompletion || null,
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
  if (options.command === 'reconcile-generation' && options.phase === 'validate') {
    const outcome = validateGenerationSnapshot(options);
    console.log(JSON.stringify({ok: true, ...outcome}));
    return 0;
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
      retiredLegacyCompleted: outcome.retiredLegacyCompleted,
      supersededByExisting: outcome.supersededByExisting,
      invalidatedGenerationCompletion: outcome.invalidatedGenerationCompletion,
      deduplicated: outcome.deduplicated,
    }));
    return 0;
  }
  if (options.command === 'reconcile-generation') {
    const outcome = options.phase === 'snapshot'
      ? snapshotGenerationCompletion(queue, options)
      : commitGenerationCompletion(queue, options);
    const saved = outcome.mutated ? writeQueue(options.file, outcome.queue) : outcome.queue;
    console.log(JSON.stringify({
      ...statusPayload(saved, options.file),
      completed: outcome.completed,
      readyForValidation: outcome.readyForValidation || false,
      reason: outcome.reason,
      coreGeneratedAt: outcome.coreGeneratedAt,
      snapshotHash: outcome.snapshotHash || '',
      activeSections: outcome.activeSections || [],
      newerRevisionSections: outcome.newerRevisionSections || [],
      conflictingGenerationSections: outcome.conflictingGenerationSections || [],
      missingCompletedSections: outcome.missingCompletedSections || [],
      conflictingCompletedSections: outcome.conflictingCompletedSections || [],
      invalidTerminalSections: outcome.invalidTerminalSections || [],
      invalidatedGenerationCompletion: outcome.invalidatedGenerationCompletion || false,
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
    const before = queue.entries.find(entry => entry.section === options.section);
    const claimedRevision = normalizeRevision(before?.claimedRevision, 0);
    const completed = completeClaim(queue, options);
    const saved = writeQueue(options.file, queue);
    const published = latestPublishedBySection(saved).get(options.section);
    const after = saved.entries.find(entry => entry.section === options.section);
    const publishedRevision = Number(published?.publishedRevision || 0);
    const followUpPending = Boolean(
      after
        && after.status === 'pending'
        && publishedRevision >= claimedRevision
        && Number(after.requestRevision || 0) > publishedRevision,
    );
    console.log(JSON.stringify({
      ok: true,
      completed,
      published: publishedRevision >= claimedRevision && claimedRevision > 0,
      publishedRevision,
      desiredRevision: Number(after?.requestRevision || publishedRevision || 0),
      followUpPending,
      ...statusPayload(saved, options.file),
    }));
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
