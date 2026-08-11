#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const DEFAULT_ROOT = process.env.SHEIN_BI_PIPELINE_MARKER_ROOT
  || path.join(process.cwd(), 'state', 'pipeline-markers');
const VALID_STATUS = new Set(['done', 'warning', 'failed', 'deferred', 'partial']);

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  pipeline_marker.mjs write --stage NAME --date YYYY-MM-DD [--business-date YYYY-MM-DD]
    [--status done|warning|failed|deferred|partial] [--message TEXT]
    [--evidence PATH] [--root PATH]
  pipeline_marker.mjs require --stage NAME --date YYYY-MM-DD
    [--status done,warning] [--not-before ISO] [--require-evidence] [--root PATH]
  pipeline_marker.mjs read --stage NAME --date YYYY-MM-DD [--root PATH]
  Evidence: --evidence paths must exist as regular files; write records deduplicated
  {path,bytes,sha256} entries. require --require-evidence re-verifies existence,
  regular-file type, size and sha256 of every recorded entry.`);
  return 64;
}

function validateStage(value) {
  const stage = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(stage)) {
    throw new TypeError('PIPELINE_MARKER_STAGE_INVALID');
  }
  return stage;
}

function validateDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new TypeError('PIPELINE_MARKER_DATE_INVALID');
  }
  return date;
}

function parseIso(value, code) {
  const text = String(value || '').trim();
  const millis = Date.parse(text);
  if (!text || Number.isNaN(millis)) throw new TypeError(code);
  return {text, millis};
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (!['write', 'require', 'read'].includes(command)) {
    throw new TypeError('PIPELINE_MARKER_COMMAND_INVALID');
  }
  const options = {
    command,
    root: DEFAULT_ROOT,
    stage: '',
    date: '',
    businessDate: '',
    status: command === 'write' ? 'done' : 'done',
    message: '',
    evidence: [],
    notBefore: '',
    requireEvidence: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = () => {
      index += 1;
      if (index >= tokens.length) throw new TypeError(`PIPELINE_MARKER_VALUE_MISSING_${token}`);
      return tokens[index];
    };
    if (token === '--root') options.root = path.resolve(next());
    else if (token === '--stage') options.stage = next();
    else if (token === '--date') options.date = next();
    else if (token === '--business-date') options.businessDate = next();
    else if (token === '--status') options.status = next();
    else if (token === '--message') options.message = next();
    else if (token === '--evidence') options.evidence.push(next());
    else if (token === '--not-before') options.notBefore = next();
    else if (token === '--require-evidence') {
      if (command !== 'require') throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
      options.requireEvidence = true;
    }
    else throw new TypeError(`PIPELINE_MARKER_ARGUMENT_UNKNOWN_${token}`);
  }
  options.stage = validateStage(options.stage);
  options.date = validateDate(options.date);
  if (options.businessDate) options.businessDate = validateDate(options.businessDate);
  if (command === 'write' && !VALID_STATUS.has(options.status)) {
    throw new TypeError('PIPELINE_MARKER_STATUS_INVALID');
  }
  if (command === 'require') {
    const statuses = String(options.status || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    if (!statuses.length || statuses.some(status => !VALID_STATUS.has(status))) {
      throw new TypeError('PIPELINE_MARKER_REQUIRED_STATUS_INVALID');
    }
    options.requiredStatuses = statuses;
  }
  if (options.notBefore) parseIso(options.notBefore, 'PIPELINE_MARKER_NOT_BEFORE_INVALID');
  return options;
}

export function markerPath(root, date, stage) {
  return path.join(path.resolve(root), validateDate(date), `${validateStage(stage)}.json`);
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o770});
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o660,
  });
  fs.renameSync(temporary, file);
}

function evidenceError(code, evidencePath) {
  const error = new TypeError(code);
  error.evidencePath = evidencePath;
  return error;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function resolveEvidenceRecords(evidence = []) {
  const records = [];
  const seen = new Set();
  for (const value of evidence || []) {
    const candidate = String(value || '').trim();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') throw evidenceError('PIPELINE_MARKER_EVIDENCE_MISSING', candidate);
      throw error;
    }
    if (!stats.isFile()) throw evidenceError('PIPELINE_MARKER_EVIDENCE_NOT_FILE', candidate);
    records.push({path: candidate, bytes: stats.size, sha256: await sha256File(candidate)});
  }
  return records;
}

export async function writeMarker({
  root = DEFAULT_ROOT,
  stage,
  date,
  businessDate = '',
  status = 'done',
  message = '',
  evidence = [],
  completedAt = new Date().toISOString(),
} = {}) {
  const normalizedStage = validateStage(stage);
  const normalizedDate = validateDate(date);
  const normalizedBusinessDate = businessDate ? validateDate(businessDate) : '';
  if (!VALID_STATUS.has(status)) throw new TypeError('PIPELINE_MARKER_STATUS_INVALID');
  const completed = parseIso(completedAt, 'PIPELINE_MARKER_COMPLETED_AT_INVALID').text;
  const evidenceRecords = await resolveEvidenceRecords(evidence);
  const payload = {
    ok: ['done', 'warning'].includes(status),
    stage: normalizedStage,
    status,
    runDate: normalizedDate,
    businessDate: normalizedBusinessDate || normalizedDate,
    completedAt: completed,
    message: String(message || '').slice(0, 1_000),
    evidence: evidenceRecords,
  };
  const file = markerPath(root, normalizedDate, normalizedStage);
  atomicWriteJson(file, payload);
  atomicWriteJson(path.join(path.resolve(root), `${normalizedStage}.latest.json`), payload);
  return {...payload, file};
}

export function readMarker({root = DEFAULT_ROOT, stage, date} = {}) {
  const file = markerPath(root, date, stage);
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {...payload, file};
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function requireMarker({
  root = DEFAULT_ROOT,
  stage,
  date,
  statuses = ['done'],
  notBefore = '',
  requireEvidence = false,
} = {}) {
  const marker = readMarker({root, stage, date});
  if (!marker) {
    return {ok: false, reason: 'marker_missing', stage, date, marker: null};
  }
  if (!statuses.includes(marker.status)) {
    return {ok: false, reason: 'marker_status_not_ready', stage, date, marker};
  }
  if (notBefore) {
    const threshold = parseIso(notBefore, 'PIPELINE_MARKER_NOT_BEFORE_INVALID');
    const completed = parseIso(marker.completedAt, 'PIPELINE_MARKER_COMPLETED_AT_INVALID');
    if (completed.millis < threshold.millis) {
      return {ok: false, reason: 'marker_too_old', stage, date, marker, notBefore: threshold.text};
    }
  }
  if (requireEvidence) {
    const failure = await verifyEvidenceRecords(marker.evidence);
    if (failure) {
      return {ok: false, reason: failure.reason, stage, date, marker, evidencePath: failure.path};
    }
  }
  return {ok: true, reason: 'ready', stage, date, marker};
}

async function verifyEvidenceRecords(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {reason: 'evidence_missing', path: null};
  }
  for (const entry of entries) {
    const candidate = entry?.path;
    const expectedBytes = entry?.bytes;
    const expectedSha256 = entry?.sha256;
    if (
      typeof candidate !== 'string' || !candidate
      || typeof expectedBytes !== 'number' || !Number.isSafeInteger(expectedBytes)
      || typeof expectedSha256 !== 'string' || !expectedSha256
    ) {
      return {reason: 'evidence_missing', path: typeof candidate === 'string' ? candidate : null};
    }
    let stats;
    try {
      stats = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return {reason: 'evidence_missing', path: candidate};
      throw error;
    }
    if (!stats.isFile()) return {reason: 'evidence_not_file', path: candidate};
    if (stats.size !== expectedBytes) return {reason: 'evidence_size_mismatch', path: candidate};
    const digest = await sha256File(candidate);
    if (digest !== expectedSha256) return {reason: 'evidence_hash_mismatch', path: candidate};
  }
  return null;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ok: false, errorCode: error?.message || 'PIPELINE_MARKER_ARGUMENT_INVALID'}));
    return usage();
  }
  if (options.command === 'write') {
    let result;
    try {
      result = await writeMarker(options);
    } catch (error) {
      if (['PIPELINE_MARKER_EVIDENCE_MISSING', 'PIPELINE_MARKER_EVIDENCE_NOT_FILE'].includes(error?.message)) {
        console.error(JSON.stringify({ok: false, errorCode: error.message, evidencePath: error.evidencePath ?? null}));
        return 1;
      }
      throw error;
    }
    console.log(JSON.stringify(result));
    return 0;
  }
  if (options.command === 'read') {
    const result = readMarker(options);
    console.log(JSON.stringify(result || {
      ok: false,
      reason: 'marker_missing',
      stage: options.stage,
      date: options.date,
    }));
    return result ? 0 : 75;
  }
  const result = await requireMarker({
    ...options,
    statuses: options.requiredStatuses,
  });
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 75;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(code => {
    process.exitCode = code;
  }).catch(error => {
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  });
}
