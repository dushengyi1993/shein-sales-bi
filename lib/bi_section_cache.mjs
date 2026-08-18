import fs from 'node:fs/promises';
import fssync from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {writeFileAtomic} from './atomic_file_publish.mjs';
import {
  scanBoundedTopLevelJson,
  streamFileHandleWithReplacement,
} from './bounded_top_level_json.mjs';

/**
 * BI section cache artifacts are plain JSON files whose metadata (ok/section/
 * generatedAt/cachedAt) is serialized before the potentially 30-100MB data
 * payload. This module therefore validates and serves them with bounded reads:
 * the raw/gzip serving path never readFile's the whole artifact, never
 * JSON.parses its data, and never gzipSync's a multi-megabyte buffer. Full
 * parses (readBiSectionCache) are still provided for consumers that must read
 * data, but they run behind a process-wide single-slot gate once an artifact
 * crosses BI_SECTION_PARSE_GATE_BYTES, so two 98MB profit parses cannot hold
 * the heap at the same time.
 */

export const BI_SECTION_METADATA_HEAD_BYTES = 8 * 1024;
export const BI_SECTION_TAIL_SCAN_BYTES = 4 * 1024;
export const BI_SECTION_PARSE_GATE_BYTES = 16 * 1024 * 1024;
export const BI_SECTION_INTEGRITY_SIDECAR_VERSION = 1;
export const BI_SECTION_INTEGRITY_SIDECAR_SUFFIX = '.integrity.json';

const BI_SECTION_INTEGRITY_SIDECAR_MAX_BYTES = 64 * 1024;
export const BI_SECTION_INTEGRITY_IN_FLIGHT_MAX = 2;
const BI_SECTION_INTEGRITY_SCHEMA = 'shein-bi-section-integrity';
const SHA256_RE = /^[a-f0-9]{64}$/;
const SECTION_METADATA_CAPTURE_LIMITS = Object.freeze({
  ok: 16,
  section: 4 * 1024,
  generatedAt: 4 * 1024,
  cachedAt: 4 * 1024,
});

/**
 * Keyed admission limiter that starts a worker only when a slot is free.
 *
 * Distinct keys beyond `limit` are queued FIFO without invoking `start`, so an
 * over-cap task demonstrably has not begun its actual work while it waits. The
 * same key -- whether already running or waiting -- always returns the exact
 * same promise, collapsing duplicate submissions into one shared validation.
 * On every settle (resolve or reject) the key entry and slot are released and
 * the next queued key is admitted, so a failed task cannot pin a slot. This is
 * a pure data structure and never mutates caller-owned state.
 *
 * @param {number} limit maximum concurrent started tasks; must be a positive
 *   integer. A non-number throws TypeError and a non-finite, non-positive or
 *   non-integer number throws RangeError synchronously -- the limiter never
 *   coerces or clamps an illegal cap, so a bad value cannot silently degrade
 *   to 1 or leave an over-cap queue permanently unadmitted.
 * @param {(...args:any[])=>any|Promise<any>} start worker invoked per key with
 *   the submitted args; may resolve or reject.
 * @returns {{submit: (key:string, args:any[])=>Promise<any>, stats: ()=>
 *   {active:number, queued:number, size:number}}}
 */
export function createUniqueKeyLimiter(limit, start) {
  if (typeof start !== 'function') throw new TypeError('Limiter worker must be a function');
  if (typeof limit !== 'number') {
    throw new TypeError('Limiter limit must be a number');
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError(`Limiter limit must be a positive integer, got ${limit}`);
  }
  const cap = limit;
  const inFlight = new Map(); // key -> {key, args, promise, resolve, reject}
  const waiters = [];
  let active = 0;

  function settle(entry, outcome, failed) {
    if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
    active = Math.max(0, active - 1);
    if (failed) entry.reject(outcome);
    else entry.resolve(outcome);
    admitNext();
  }

  function run(entry) {
    active += 1;
    let result;
    try {
      result = start(...entry.args);
    } catch (error) {
      settle(entry, error, true);
      return;
    }
    Promise.resolve(result).then(
      value => settle(entry, value, false),
      error => settle(entry, error, true),
    );
  }

  function admitNext() {
    while (active < cap && waiters.length > 0) {
      const entry = waiters.shift();
      if (inFlight.get(entry.key) !== entry) continue; // stale waiter, superseded
      run(entry);
    }
  }

  function submit(key, args) {
    const existing = inFlight.get(key);
    if (existing) return existing.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry = {key, args, promise, resolve, reject};
    inFlight.set(key, entry);
    if (active < cap) run(entry);
    else waiters.push(entry);
    return promise;
  }

  function stats() {
    return {active, queued: waiters.length, size: inFlight.size};
  }

  return {submit, stats};
}

// Process-wide admission limiter for section integrity revalidation. Distinct
// keys that arrive at or beyond the cap are queued and do NOT invoke
// validateAndPublishSectionIntegrity until an active task settles, so the
// concurrency cap holds before any heavy validation begins. A repeated key
// (running or queued) always shares one promise; every success and failure
// releases its slot and entry.
const biSectionIntegrityAdmission = createUniqueKeyLimiter(
  BI_SECTION_INTEGRITY_IN_FLIGHT_MAX,
  (file, section, generatedAt) =>
    validateAndPublishSectionIntegrity(file, section, generatedAt).then(() => true, () => false),
);

async function readJsonFile(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function extractJsonStringFieldFromHead(head, field) {
  const re = new RegExp('"' + field + '"\\s*:\\s*"([^"]*)"');
  return re.exec(head)?.[1] || '';
}

export function acceptsGzip(value) {
  const qualities = new Map();
  for (const item of String(value || '').split(',')) {
    const [codingPart, ...parameters] = item.trim().split(';');
    const coding = codingPart.trim().toLowerCase();
    if (!coding) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(\d*(?:\.\d+)?)\s*$/i.exec(parameter);
      if (match) {
        const parsed = Number(match[1]);
        quality = Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
      }
    }
    qualities.set(coding, quality);
  }
  if (qualities.has('gzip')) return qualities.get('gzip') > 0;
  return (qualities.get('*') || 0) > 0;
}

function sectionFile(root, section) {
  return path.join(root, 'sections', String(section || '') + '.json');
}

function integritySidecarFile(file) {
  return file + BI_SECTION_INTEGRITY_SIDECAR_SUFFIX;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function statBinding(stat) {
  return {
    device: String(stat?.dev ?? ''),
    inode: String(stat?.ino ?? ''),
    mode: String(stat?.mode ?? ''),
    size: Number(stat?.size ?? 0),
    mtimeNs: String(stat?.mtimeNs ?? ''),
    ctimeNs: String(stat?.ctimeNs ?? ''),
    birthtimeNs: String(stat?.birthtimeNs ?? ''),
  };
}

function statBindingMatches(stat, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  return canonicalJson(statBinding(stat)) === canonicalJson(expected);
}

function generationIdentityFor(section, generatedAt, cachedAt, rawSha256, rawByteSize) {
  return sha256(canonicalJson({
    section: String(section || ''),
    generatedAt: String(generatedAt || ''),
    cachedAt: String(cachedAt || ''),
    rawSha256: String(rawSha256 || ''),
    rawByteSize: Number(rawByteSize || 0),
  }));
}

function sidecarBindingSha256(sidecar) {
  const body = {...sidecar};
  delete body.bindingSha256;
  return sha256(canonicalJson(body));
}

async function readSmallJsonFile(file, maxBytes) {
  let handle = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const size = Number(stat?.size || 0);
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) return null;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const {bytesRead} = await handle.read(buffer, offset, size - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function integritySidecarMatches(sidecar, file, section, generatedAt, rawStat, gzipStat = null) {
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar)) return false;
  if (sidecar.schema !== BI_SECTION_INTEGRITY_SCHEMA
    || sidecar.version !== BI_SECTION_INTEGRITY_SIDECAR_VERSION
    || sidecar.algorithm !== 'sha256') return false;
  if (!SHA256_RE.test(String(sidecar.bindingSha256 || ''))
    || sidecarBindingSha256(sidecar) !== sidecar.bindingSha256) return false;

  const expectedSection = String(section || '');
  const expectedGeneratedAt = String(generatedAt || '');
  if (String(sidecar.section || '') !== expectedSection) return false;
  if (expectedGeneratedAt && String(sidecar.generatedAt || '') !== expectedGeneratedAt) return false;
  if (typeof sidecar.generatedAt !== 'string'
    || typeof sidecar.cachedAt !== 'string'
    || !sidecar.cachedAt
    || typeof sidecar.publishedAt !== 'string') return false;

  const raw = sidecar.raw;
  const gzip = sidecar.gzip;
  if (!raw || typeof raw !== 'object' || !gzip || typeof gzip !== 'object') return false;
  if (raw.file !== path.basename(file) || gzip.file !== path.basename(file + '.gz')) return false;
  if (!SHA256_RE.test(String(raw.sha256 || '')) || !SHA256_RE.test(String(gzip.sha256 || ''))) return false;
  if (!Number.isSafeInteger(raw.byteSize) || raw.byteSize <= 0
    || !Number.isSafeInteger(gzip.byteSize) || gzip.byteSize <= 0) return false;
  if (raw.byteSize !== Number(rawStat?.size || 0) || !statBindingMatches(rawStat, raw.stat)) return false;
  if (gzip.sourceRawSha256 !== raw.sha256) return false;

  const generationIdentity = generationIdentityFor(
    sidecar.section,
    sidecar.generatedAt,
    sidecar.cachedAt,
    raw.sha256,
    raw.byteSize,
  );
  if (sidecar.generationIdentity !== generationIdentity
    || gzip.sourceGenerationIdentity !== generationIdentity) return false;
  if (gzipStat && (gzip.byteSize !== Number(gzipStat?.size || 0) || !statBindingMatches(gzipStat, gzip.stat))) return false;
  return true;
}

function createIntegritySidecar(file, metadata, raw, gzip) {
  const generationIdentity = generationIdentityFor(
    metadata.section,
    metadata.generatedAt,
    metadata.cachedAt,
    raw.sha256,
    raw.byteSize,
  );
  const sidecar = {
    schema: BI_SECTION_INTEGRITY_SCHEMA,
    version: BI_SECTION_INTEGRITY_SIDECAR_VERSION,
    algorithm: 'sha256',
    section: String(metadata.section || ''),
    generatedAt: String(metadata.generatedAt || ''),
    cachedAt: String(metadata.cachedAt || ''),
    generationIdentity,
    publishedAt: new Date().toISOString(),
    raw: {
      file: path.basename(file),
      sha256: raw.sha256,
      byteSize: raw.byteSize,
      stat: statBinding(raw.stat),
    },
    gzip: {
      file: path.basename(file + '.gz'),
      sha256: gzip.sha256,
      byteSize: gzip.byteSize,
      stat: statBinding(gzip.stat),
      sourceRawSha256: raw.sha256,
      sourceGenerationIdentity: generationIdentity,
    },
  };
  sidecar.bindingSha256 = sidecarBindingSha256(sidecar);
  return sidecar;
}

async function publishIntegritySidecar(file, metadata, raw, gzip) {
  const sidecar = createIntegritySidecar(file, metadata, raw, gzip);
  await writeFileAtomic(
    integritySidecarFile(file),
    JSON.stringify(sidecar, null, 2) + '\n',
    {encoding: 'utf8'},
  );
  const readback = await readSmallJsonFile(integritySidecarFile(file), BI_SECTION_INTEGRITY_SIDECAR_MAX_BYTES);
  if (!integritySidecarMatches(readback, file, metadata.section, metadata.generatedAt, raw.stat, gzip.stat)) {
    throw new Error('BI section integrity sidecar readback mismatch');
  }
  return readback;
}

async function readSectionHead(handle, stat) {
  const size = Number(stat?.size || 0);
  if (!Number.isSafeInteger(size) || size <= 0) return '';
  const headBytes = Math.max(1, Math.min(BI_SECTION_METADATA_HEAD_BYTES, size));
  const head = Buffer.allocUnsafe(headBytes);
  const {bytesRead} = await handle.read(head, 0, headBytes, 0);
  return head.subarray(0, bytesRead).toString('utf8');
}

function sectionHeadMatches(head, section, generatedAt) {
  if (extractJsonStringFieldFromHead(head, 'section') !== String(section || '')) return false;
  const expectedGeneratedAt = String(generatedAt || '');
  if (expectedGeneratedAt && extractJsonStringFieldFromHead(head, 'generatedAt') !== expectedGeneratedAt) return false;
  return /(?:^|[,{]\s*)"data"\s*:/.test(head);
}

async function* hashFileChunks(handle, stat, state) {
  const size = Number(stat?.size || 0);
  if (size <= 0) return;
  const stream = handle.createReadStream({start: 0, end: size - 1, autoClose: false});
  let completed = false;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      state.hash.update(chunk);
      state.byteSize += chunk.length;
      yield chunk;
    }
    completed = true;
  } finally {
    if (!completed && !stream.destroyed) stream.destroy();
  }
}

async function scanAndHashSectionHandle(handle, stat, section, generatedAt) {
  const head = await readSectionHead(handle, stat);
  if (!sectionHeadMatches(head, section, generatedAt)) {
    throw new Error('BI section metadata head mismatch');
  }
  const state = {hash: createHash('sha256'), byteSize: 0};
  const scan = await scanBoundedTopLevelJson(
    hashFileChunks(handle, stat, state),
    SECTION_METADATA_CAPTURE_LIMITS,
  );
  const after = await handle.stat({bigint: true});
  if (!statBindingMatches(after, statBinding(stat))) {
    throw new Error('BI section raw file changed during syntax validation');
  }
  const fields = scan.fields || {};
  const actualSection = fields.section?.value;
  const actualGeneratedAt = fields.generatedAt?.value;
  const cachedAt = fields.cachedAt?.value;
  if (fields.ok?.value !== true
    || typeof actualSection !== 'string'
    || actualSection !== String(section || '')
    || typeof actualGeneratedAt !== 'string'
    || (String(generatedAt || '') && actualGeneratedAt !== String(generatedAt || ''))
    || typeof cachedAt !== 'string'
    || !cachedAt) {
    throw new Error('BI section bounded metadata validation failed');
  }
  if (scan.byteLength !== Number(stat?.size || 0) || state.byteSize !== scan.byteLength) {
    throw new Error('BI section byte length changed during syntax validation');
  }
  return {
    section: actualSection,
    generatedAt: actualGeneratedAt,
    cachedAt,
    sha256: state.hash.digest('hex'),
    byteSize: state.byteSize,
    stat: after,
  };
}

async function hashFileHandle(handle, stat) {
  const state = {hash: createHash('sha256'), byteSize: 0};
  for await (const _chunk of hashFileChunks(handle, stat, state)) {
    // Hashing happens inside the bounded iterator; no chunks are retained.
  }
  const after = await handle.stat({bigint: true});
  if (!statBindingMatches(after, statBinding(stat))) throw new Error('File changed while hashing');
  return {sha256: state.hash.digest('hex'), byteSize: state.byteSize, stat: after};
}

function createHashingTransform() {
  const hash = createHash('sha256');
  let byteSize = 0;
  let finished = false;
  return {
    stream: new Transform({
      transform(chunk, _encoding, callback) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        byteSize += buffer.length;
        callback(null, buffer);
      },
    }),
    finish() {
      if (finished) throw new Error('Hashing transform already finalized');
      finished = true;
      return {sha256: hash.digest('hex'), byteSize};
    },
  };
}

async function fsyncPublishedDirectory(dir) {
  if (process.platform === 'win32') return;
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishGzipFromValidatedRaw(file, rawHandle, raw) {
  const gzipFile = file + '.gz';
  const tmp = gzipTempPathFor(gzipFile);
  await fs.mkdir(path.dirname(tmp), {recursive: true});
  let renamed = false;
  let gzipHandle = null;
  try {
    const sourceTap = createHashingTransform();
    const gzipTap = createHashingTransform();
    await pipeline(
      rawHandle.createReadStream({start: 0, end: raw.byteSize - 1, autoClose: false}),
      sourceTap.stream,
      createGzip({level: 6}),
      gzipTap.stream,
      fssync.createWriteStream(tmp, {flags: 'wx'}),
    );
    const sourceDigest = sourceTap.finish();
    const generatedGzip = gzipTap.finish();
    if (sourceDigest.sha256 !== raw.sha256 || sourceDigest.byteSize !== raw.byteSize) {
      throw new Error('BI section raw changed between validation and gzip generation');
    }
    const rawAfterCompression = await rawHandle.stat({bigint: true});
    const rawPathAfterCompression = await fs.stat(file, {bigint: true});
    if (!statBindingMatches(rawAfterCompression, statBinding(raw.stat))
      || !statBindingMatches(rawPathAfterCompression, statBinding(raw.stat))) {
      throw new Error('BI section raw identity changed before gzip publication');
    }

    const tempHandle = await fs.open(tmp, 'r+');
    try {
      await tempHandle.sync();
    } finally {
      await tempHandle.close();
    }
    await fs.rename(tmp, gzipFile);
    renamed = true;
    await fsyncPublishedDirectory(path.dirname(gzipFile));

    gzipHandle = await fs.open(gzipFile, 'r');
    const gzipStat = await gzipHandle.stat({bigint: true});
    const publishedGzip = await hashFileHandle(gzipHandle, gzipStat);
    if (publishedGzip.sha256 !== generatedGzip.sha256
      || publishedGzip.byteSize !== generatedGzip.byteSize) {
      throw new Error('Published BI section gzip digest mismatch');
    }
    const rawFinal = await rawHandle.stat({bigint: true});
    const rawPathFinal = await fs.stat(file, {bigint: true});
    if (!statBindingMatches(rawFinal, statBinding(raw.stat))
      || !statBindingMatches(rawPathFinal, statBinding(raw.stat))) {
      throw new Error('BI section raw identity changed while verifying gzip');
    }
    return publishedGzip;
  } finally {
    await gzipHandle?.close().catch(() => {});
    if (!renamed) await fs.rm(tmp, {force: true}).catch(() => {});
  }
}

async function validateAndPublishSectionIntegrity(file, section, generatedAt) {
  let rawHandle = null;
  try {
    rawHandle = await fs.open(file, 'r');
    const rawStat = await rawHandle.stat({bigint: true});
    if (Number(rawStat?.size || 0) <= 0) throw new Error('Empty BI section raw file');
    const raw = await scanAndHashSectionHandle(rawHandle, rawStat, section, generatedAt);
    const gzip = await publishGzipFromValidatedRaw(file, rawHandle, raw);
    const rawFinal = await rawHandle.stat({bigint: true});
    const rawPathFinal = await fs.stat(file, {bigint: true});
    if (!statBindingMatches(rawFinal, statBinding(raw.stat))
      || !statBindingMatches(rawPathFinal, statBinding(raw.stat))) {
      throw new Error('BI section raw identity changed before sidecar publication');
    }
    raw.stat = rawFinal;
    await publishIntegritySidecar(file, raw, raw, gzip);
    return true;
  } finally {
    await rawHandle?.close().catch(() => {});
  }
}

async function ensureSectionIntegrity(file, section, generatedAt, observedStat) {
  const key = [
    path.resolve(file),
    String(section || ''),
    String(generatedAt || ''),
    canonicalJson(statBinding(observedStat)),
  ].join('|');
  return biSectionIntegrityAdmission.submit(key, [file, section, generatedAt]);
}

async function openMatchingGzipPayload(file, section, generatedAt, rawStat) {
  const sidecar = await readSmallJsonFile(
    integritySidecarFile(file),
    BI_SECTION_INTEGRITY_SIDECAR_MAX_BYTES,
  );
  if (!integritySidecarMatches(sidecar, file, section, generatedAt, rawStat)) return null;
  let handle = null;
  try {
    handle = await fs.open(file + '.gz', 'r');
    const stat = await handle.stat({bigint: true});
    if (!integritySidecarMatches(sidecar, file, section, generatedAt, rawStat, stat)) return null;
    const payload = {handle, stat, sidecar};
    handle = null;
    return payload;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openIntegrityBoundSection(file, section, generatedAt) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let rawHandle = null;
    let gzipHandle = null;
    try {
      rawHandle = await fs.open(file, 'r');
      const rawStat = await rawHandle.stat({bigint: true});
      if (Number(rawStat?.size || 0) <= 0) return null;
      const head = await readSectionHead(rawHandle, rawStat);
      if (!sectionHeadMatches(head, section, generatedAt)) return null;
      const gzip = await openMatchingGzipPayload(file, section, generatedAt, rawStat);
      if (gzip) {
        gzipHandle = gzip.handle;
        const rawAfter = await rawHandle.stat({bigint: true});
        if (!statBindingMatches(rawAfter, statBinding(rawStat))) return null;
        const result = {
          rawHandle,
          rawStat: rawAfter,
          gzipHandle,
          gzipStat: gzip.stat,
          sidecar: gzip.sidecar,
        };
        rawHandle = null;
        gzipHandle = null;
        return result;
      }
      await rawHandle.close().catch(() => {});
      rawHandle = null;
      if (attempt === 0 && await ensureSectionIntegrity(file, section, generatedAt, rawStat)) continue;
      return null;
    } catch {
      return null;
    } finally {
      await rawHandle?.close().catch(() => {});
      await gzipHandle?.close().catch(() => {});
    }
  }
  return null;
}

// ---- Bounded metadata/identity reads --------------------------------------

/**
 * Read only the small leading metadata head of a section artifact. Never
 * materialises data and never JSON.parses the payload; suitable for
 * existence, generation and revision decisions on 30-100MB sections.
 */
export async function readBiSectionMetadata(root, section) {
  const file = sectionFile(root, section);
  let handle = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    const size = Number(stat?.size || 0);
    if (size <= 0) return null;
    const headBytes = Math.max(1, Math.min(BI_SECTION_METADATA_HEAD_BYTES, size));
    const head = Buffer.allocUnsafe(headBytes);
    const {bytesRead} = await handle.read(head, 0, headBytes, 0);
    const headText = head.subarray(0, bytesRead).toString('utf8');
    const generatedAt = extractJsonStringFieldFromHead(headText, 'generatedAt');
    const cachedAt = extractJsonStringFieldFromHead(headText, 'cachedAt');
    if (!generatedAt || !cachedAt) return null;
    return {
      ok: true,
      section: String(section || ''),
      generatedAt,
      cachedAt,
      hasData: /"data"\s*:/.test(headText),
      size,
      mtimeMs: Number(stat.mtimeMs || 0),
      cacheKey: [path.resolve(root), section, generatedAt, cachedAt, Number(stat.size || 0), Number(stat.mtimeMs || 0)].join('|'),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** True only when raw and gzip are bound by a matching integrity sidecar. */
export async function biSectionIdentityMatches(root, section, generatedAt) {
  const artifacts = await openIntegrityBoundSection(sectionFile(root, section), section, generatedAt);
  if (!artifacts) return false;
  await artifacts.rawHandle.close().catch(() => {});
  await artifacts.gzipHandle.close().catch(() => {});
  return true;
}

// ---- Full-parse path (bounded concurrency) --------------------------------

let biSectionParseTail = Promise.resolve();

function withBiSectionParseSlot(work) {
  const run = biSectionParseTail.then(work, work);
  biSectionParseTail = run.catch(() => {});
  return run;
}

async function parseValidatedSection(file, section, generatedAt) {
  const cached = await readJsonFile(file, null);
  if (!cached || typeof cached !== 'object') return null;
  if (String(cached.section || '') !== String(section || '')) return null;
  const expected = String(generatedAt || '');
  if (expected && String(cached.generatedAt || '') !== expected) return null;
  if (!cached.data || typeof cached.data !== 'object') return null;
  return cached;
}

/**
 * Read and parse a complete section artifact. Artifacts at or above
 * BI_SECTION_PARSE_GATE_BYTES run behind a process-wide single-slot gate so
 * at most one 30-100MB parse can hold the heap at a time; small artifacts are
 * parsed immediately to preserve existing latency. Failure semantics are
 * unchanged: a missing/invalid/mismatched artifact returns null.
 */
export async function readBiSectionCache(root, section, generatedAt) {
  const file = sectionFile(root, section);
  const stat = await fs.stat(file).catch(() => null);
  const gate = Number(stat?.size || 0) >= BI_SECTION_PARSE_GATE_BYTES;
  const parse = () => parseValidatedSection(file, section, generatedAt);
  return gate ? withBiSectionParseSlot(parse) : parse();
}

export async function readBiSectionCacheAnyGeneratedAt(root, section) {
  return readBiSectionCache(root, section, '');
}

// ---- Streaming raw/gzip serving -------------------------------------------

let biSectionOpenStreams = 0;

/** Number of section file handles currently owned by serving streams. */
export function getBiSectionOpenStreamCount() {
  return biSectionOpenStreams;
}

async function* streamSectionFileChunks(handle, stat, replacement = null) {
  yield* streamFileHandleWithReplacement(handle, stat, replacement);
}

function ownedSectionStream(handle, stat, replacement = null) {
  biSectionOpenStreams += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    biSectionOpenStreams = Math.max(0, biSectionOpenStreams - 1);
    handle.close().catch(() => {});
  };
  let stream;
  try {
    stream = Readable.from(streamSectionFileChunks(handle, stat, replacement));
  } catch (error) {
    release();
    throw error;
  }
  stream.once('close', release);
  stream.once('error', release);
  return stream;
}

function streamDescriptor(stream, headers) {
  return {stream, headers};
}

function attachLink(source, destination) {
  source.on('error', () => destination.destroy());
  destination.on('error', () => source.destroy());
  destination.on('close', () => source.destroy());
}

/**
 * Build a byte-range replacement that appends cacheHit/extraFields metadata at
 * the closing brace of a section artifact, preserving the trailing newline
 * brace newline shape of the original file.
 */
function buildTailReplacement(objectClose, cacheHit, extraFields) {
  const pairs = [['cacheHit', Boolean(cacheHit)]];
  for (const [key, value] of Object.entries(extraFields || {})) {
    if (value === undefined) continue;
    pairs.push([key, value]);
  }
  const extra = pairs.map(([key, value]) => ',\n  ' + JSON.stringify(key) + ': ' + JSON.stringify(value)).join('');
  return {
    start: objectClose,
    end: objectClose + 1,
    value: Buffer.from(extra + '\n}\n', 'utf8'),
  };
}

/**
 * Return a stream descriptor only after raw and gzip match an atomically
 * published integrity sidecar. A legacy/unbound artifact takes the bounded
 * slow path once: complete JSON syntax scan + raw hash, gzip generation from
 * that same validated FileHandle, published gzip verification, and sidecar
 * readback. No gzip is trusted merely because its mtime looks newer.
 */
export async function readBiSectionRawStream(root, section, generatedAt, cacheHit = true, options = {}) {
  const file = sectionFile(root, section);
  let rawHandle = null;
  let gzipHandle = null;
  try {
    const artifacts = await openIntegrityBoundSection(file, section, generatedAt);
    if (!artifacts) return null;
    rawHandle = artifacts.rawHandle;
    gzipHandle = artifacts.gzipHandle;
    const rawStat = artifacts.rawStat;
    const gzipStat = artifacts.gzipStat;
    const size = Number(rawStat.size);
    const tailScan = Math.max(1, Math.min(BI_SECTION_TAIL_SCAN_BYTES, size));
    const tailStart = size - tailScan;
    const tail = Buffer.allocUnsafe(tailScan);
    const {bytesRead: tailRead} = await rawHandle.read(tail, 0, tailScan, tailStart);
    let objectClose = -1;
    for (let index = tailRead - 1; index >= 0; index -= 1) {
      const byte = tail[index];
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
      if (byte === 0x7d) objectClose = tailStart + index;
      break;
    }
    if (objectClose < 0) return null;
    const rawReady = await rawHandle.stat({bigint: true});
    const gzipReady = await gzipHandle.stat({bigint: true});
    if (!statBindingMatches(rawReady, artifacts.sidecar.raw.stat)
      || !statBindingMatches(gzipReady, artifacts.sidecar.gzip.stat)) return null;

    const extraFields = options.extraFields && typeof options.extraFields === 'object' ? options.extraFields : {};
    const hasExtraFields = Object.keys(extraFields).length > 0;
    const baseHeaders = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
    };

    if (options.gzip) {
      if (!hasExtraFields) {
        await rawHandle.close().catch(() => {});
        rawHandle = null;
        const directGzip = ownedSectionStream(gzipHandle, gzipStat, null);
        gzipHandle = null;
        return streamDescriptor(directGzip, {
          ...baseHeaders,
          'Content-Encoding': 'gzip',
          'Content-Length': String(Number(gzipStat.size)),
          'Vary': 'Accept-Encoding',
          'X-BI-Section-Mode': 'raw-cache-gzip',
          ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
        });
      }
      await gzipHandle.close().catch(() => {});
      gzipHandle = null;
      const source = ownedSectionStream(
        rawHandle,
        rawStat,
        buildTailReplacement(objectClose, cacheHit, extraFields),
      );
      rawHandle = null;
      const gzip = createGzip({level: 6});
      attachLink(source, gzip);
      source.pipe(gzip);
      return streamDescriptor(gzip, {
        ...baseHeaders,
        'Content-Encoding': 'gzip',
        'Vary': 'Accept-Encoding',
        'X-BI-Section-Mode': hasExtraFields ? 'raw-cache-gzip-meta' : 'raw-cache-gzip',
        ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
      });
    }

    await gzipHandle.close().catch(() => {});
    gzipHandle = null;
    const replacement = buildTailReplacement(objectClose, cacheHit, extraFields);
    const identityStream = ownedSectionStream(rawHandle, rawStat, replacement);
    rawHandle = null;
    return streamDescriptor(identityStream, {
      ...baseHeaders,
      'X-BI-Section-Mode': 'raw-cache',
      ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
    });
  } catch {
    return null;
  } finally {
    await rawHandle?.close().catch(() => {});
    await gzipHandle?.close().catch(() => {});
  }
}

/** Compatibility alias retained for consumers that used the old name. */
export const readBiSectionCacheRaw = readBiSectionRawStream;

export async function readBiSectionStaleRaw(root, section, currentGeneratedAt, options = {}) {
  const stale = await readBiSectionRawStream(root, section, '', true, {
    ...options,
    extraFields: {
      ...(options.extraFields && typeof options.extraFields === 'object' ? options.extraFields : {}),
      staleSection: true,
      cacheStale: true,
      refreshScheduled: Boolean(options.refreshScheduled),
      coreGeneratedAt: String(currentGeneratedAt || ''),
    },
  });
  if (!stale) return null;
  return {
    stream: stale.stream,
    headers: {...stale.headers, 'X-BI-Section-Stale': 'true', 'Cache-Control': 'no-store'},
  };
}

// ---- Writes ----------------------------------------------------------------

function gzipTempPathFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  return path.join(dir, '.' + base + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(16).slice(2) + '.gz.tmp');
}

async function writeGzipCache(file, rawBuffer) {
  // Never gzipSync a 30-100MB JSON buffer into the same heap: compress into a
  // same-directory temp first, read back only the small compressed artifact,
  // and publish it with the shared atomic publisher so readers observe the old
  // or new .gz, never a partially written one.
  const gzipFile = `${file}.gz`;
  const tmp = gzipTempPathFor(gzipFile);
  await fs.mkdir(path.dirname(tmp), {recursive: true});
  let gzipped = null;
  try {
    await pipeline(Readable.from([rawBuffer]), createGzip({level: 6}), fssync.createWriteStream(tmp));
    gzipped = await fs.readFile(tmp);
  } finally {
    await fs.rm(tmp, {force: true}).catch(() => {});
  }
  await writeFileAtomic(`${file}.gz`, gzipped);
  return gzipped;
}

async function hashCurrentFileArtifact(file) {
  let handle = null;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat({bigint: true});
    if (Number(stat?.size || 0) <= 0) throw new Error('Empty BI section artifact');
    const artifact = await hashFileHandle(handle, stat);
    const pathStat = await fs.stat(file, {bigint: true});
    if (!statBindingMatches(pathStat, statBinding(artifact.stat))) {
      throw new Error('BI section artifact path changed while hashing');
    }
    return artifact;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function publishWrittenSectionIntegrity(file, payload, rawBuffer, gzipBuffer) {
  const expectedRawSha256 = sha256(rawBuffer);
  const expectedGzipSha256 = sha256(gzipBuffer);
  const raw = await hashCurrentFileArtifact(file);
  const gzip = await hashCurrentFileArtifact(file + '.gz');
  if (raw.sha256 !== expectedRawSha256 || raw.byteSize !== rawBuffer.length) {
    throw new Error('Written BI section raw digest mismatch');
  }
  if (gzip.sha256 !== expectedGzipSha256 || gzip.byteSize !== gzipBuffer.length) {
    throw new Error('Written BI section gzip digest mismatch');
  }
  const rawFinal = await fs.stat(file, {bigint: true});
  const gzipFinal = await fs.stat(file + '.gz', {bigint: true});
  if (!statBindingMatches(rawFinal, statBinding(raw.stat))
    || !statBindingMatches(gzipFinal, statBinding(gzip.stat))) {
    throw new Error('Written BI section artifacts changed before sidecar publication');
  }
  raw.stat = rawFinal;
  gzip.stat = gzipFinal;
  await publishIntegritySidecar(file, payload, raw, gzip);
}

export async function writeBiSectionCache(root, section, generatedAt, data, run, options = {}) {
  const file = sectionFile(root, section);
  const payload = {
    ok: true,
    section,
    generatedAt: generatedAt || '',
    cachedAt: new Date().toISOString(),
    data,
    run: run ? {
      code: run.code,
      timedOut: Boolean(run.timedOut),
      stderrTail: String(run.stderr || '').slice(-4000),
    } : null,
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  await writeFileAtomic(file, raw);
  try {
    const gzipped = await writeGzipCache(file, raw);
    await publishWrittenSectionIntegrity(file, payload, raw, gzipped);
  } catch (error) {
    (options.onGzipError || console.warn)('BI section gzip/integrity cache write failed', section, error?.message || error);
  }
  return payload;
}
