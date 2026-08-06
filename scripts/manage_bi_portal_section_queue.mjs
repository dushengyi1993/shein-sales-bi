#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const DEFAULT_FILE = process.env.SHEIN_BI_PORTAL_SECTION_QUEUE_FILE
  || path.join(process.cwd(), 'state', 'portal-section-queue', 'queue.json');
const SECTION_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const QUEUE_AGING_INTERVAL_MS = 2 * 60 * 1_000;

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  manage_bi_portal_section_queue.mjs enqueue --sections CSV [--priority N] [--reason TEXT] [--file PATH]
  manage_bi_portal_section_queue.mjs claim [--lease-seconds N] [--file PATH]
  manage_bi_portal_section_queue.mjs complete --section NAME --lease-id ID [--file PATH]
  manage_bi_portal_section_queue.mjs fail --section NAME --lease-id ID [--error TEXT] [--file PATH]
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
    else throw new TypeError(`QUEUE_ARGUMENT_UNKNOWN_${token}`);
  }
  if (!Number.isSafeInteger(options.priority) || options.priority < 0 || options.priority > 1_000) {
    throw new TypeError('QUEUE_PRIORITY_INVALID');
  }
  if (!Number.isSafeInteger(options.leaseSeconds) || options.leaseSeconds < 30 || options.leaseSeconds > 86_400) {
    throw new TypeError('QUEUE_LEASE_SECONDS_INVALID');
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
    entries: [],
  };
}

function readQueue(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      version: 1,
      updatedAt: String(value?.updatedAt || ''),
      entries: Array.isArray(value?.entries) ? value.entries : [],
    };
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
  for (const rawSection of sections || []) {
    const section = normalizeSection(rawSection);
    let entry = queue.entries.find(candidate => candidate.section === section);
    if (!entry) {
      entry = {
        section,
        priority,
        status: 'pending',
        requestedAt: nowIso,
        updatedAt: nowIso,
        reasons: [],
        attempts: 0,
        leaseId: '',
        leaseExpiresAt: '',
        lastError: '',
      };
      queue.entries.push(entry);
    } else {
      entry.priority = Math.min(Number(entry.priority ?? priority), priority);
      entry.updatedAt = nowIso;
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
  // bound on starvation for the rest of the queue.
  const effectivePriority = entry => {
    const priority = Math.max(0, Number(entry.priority || 0));
    if (priority === 0) return 0;
    const requestedAt = Date.parse(entry.requestedAt || '');
    const waitedMillis = Number.isFinite(requestedAt) ? Math.max(0, nowMillis - requestedAt) : 0;
    const ageCredit = Math.floor(waitedMillis / QUEUE_AGING_INTERVAL_MS);
    return Math.max(1, priority - ageCredit);
  };
  const pending = queue.entries
    .filter(entry => entry.status === 'pending')
    .sort((left, right) => (
      effectivePriority(left) - effectivePriority(right)
      || String(left.requestedAt || '').localeCompare(String(right.requestedAt || ''))
      || Number(left.priority || 0) - Number(right.priority || 0)
      || String(left.section).localeCompare(String(right.section))
    ));
  const entry = pending[0];
  if (!entry) return null;
  entry.status = 'running';
  entry.attempts = Number(entry.attempts || 0) + 1;
  entry.leaseId = leaseId;
  entry.leaseExpiresAt = new Date(nowMillis + leaseSeconds * 1_000).toISOString();
  entry.updatedAt = now.toISOString();
  return {...entry};
}

export function completeClaim(queue, {section, leaseId} = {}) {
  const normalizedSection = normalizeSection(section);
  const index = queue.entries.findIndex(entry => entry.section === normalizedSection);
  if (index < 0) return false;
  const entry = queue.entries[index];
  if (entry.status !== 'running' || entry.leaseId !== leaseId) {
    throw new Error('QUEUE_LEASE_MISMATCH');
  }
  queue.entries.splice(index, 1);
  return true;
}

export function failClaim(queue, {section, leaseId, error = '', now = new Date()} = {}) {
  const normalizedSection = normalizeSection(section);
  const entry = queue.entries.find(candidate => candidate.section === normalizedSection);
  if (!entry) return false;
  if (entry.status !== 'running' || entry.leaseId !== leaseId) {
    throw new Error('QUEUE_LEASE_MISMATCH');
  }
  entry.status = 'pending';
  entry.leaseId = '';
  entry.leaseExpiresAt = '';
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
    completeClaim(queue, options);
    const saved = writeQueue(options.file, queue);
    console.log(JSON.stringify(statusPayload(saved, options.file)));
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
