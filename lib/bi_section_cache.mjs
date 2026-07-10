import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

async function readJsonFile(file, fallback = null) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

async function writeBufferFileAtomic(file, buffer) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, buffer);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, {force: true}).catch(() => {});
    throw error;
  }
}

function appendJsonFieldsToJsonObjectBuffer(buffer, fields = {}) {
  if (!Buffer.isBuffer(buffer)) return null;
  const pairs = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!pairs.length) return buffer;
  let end = buffer.length;
  while (end > 0) {
    const c = buffer[end - 1];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) break;
    end -= 1;
  }
  if (end < 2 || buffer[end - 1] !== 0x7d) return null;
  const extra = pairs.map(([key, value]) => `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join('');
  return Buffer.concat([
    buffer.subarray(0, end - 1),
    Buffer.from(`${extra}\n}\n`, 'utf8'),
  ]);
}

function appendCacheHit(buffer, cacheHit, extraFields = {}) {
  return appendJsonFieldsToJsonObjectBuffer(buffer, {cacheHit: Boolean(cacheHit), ...extraFields});
}

function extractJsonStringFieldFromHead(head, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`);
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

async function writeGzipCache(file, rawBuffer) {
  const gzipped = gzipSync(rawBuffer, {level: 6});
  await writeBufferFileAtomic(`${file}.gz`, gzipped);
  return gzipped;
}

async function readOrCreateGzipCache(file, rawBuffer) {
  const gzipFile = `${file}.gz`;
  const [rawStat, gzipStat] = await Promise.all([
    fs.stat(file).catch(() => null),
    fs.stat(gzipFile).catch(() => null),
  ]);
  if (gzipStat?.size > 0 && (!rawStat || gzipStat.mtimeMs >= rawStat.mtimeMs)) {
    const existing = await fs.readFile(gzipFile).catch(() => null);
    if (existing?.length) return existing;
  }
  const gzipped = gzipSync(rawBuffer, {level: 6});
  writeBufferFileAtomic(gzipFile, gzipped).catch(() => {});
  return gzipped;
}

function sectionFile(root, section) {
  return path.join(root, 'sections', `${section}.json`);
}

export async function readBiSectionCache(root, section, generatedAt) {
  const cached = await readJsonFile(sectionFile(root, section));
  if (!cached || typeof cached !== 'object') return null;
  if (String(cached.section || '') !== String(section || '')) return null;
  const expected = String(generatedAt || '');
  if (expected && String(cached.generatedAt || '') !== expected) return null;
  if (!cached.data || typeof cached.data !== 'object') return null;
  return cached;
}

export async function readBiSectionCacheAnyGeneratedAt(root, section) {
  return readBiSectionCache(root, section, '');
}

export async function readBiSectionCacheRaw(root, section, generatedAt, cacheHit = true, options = {}) {
  const file = sectionFile(root, section);
  const buffer = await fs.readFile(file).catch(() => null);
  if (!buffer?.length) return null;

  // Metadata is deliberately serialized before data, so a bounded head read is
  // enough to validate a large cache without parsing its multi-megabyte payload.
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf8');
  const expected = String(generatedAt || '');
  if (expected && extractJsonStringFieldFromHead(head, 'generatedAt') !== expected) return null;
  if (extractJsonStringFieldFromHead(head, 'section') !== String(section || '')) return null;
  if (!/"data"\s*:/.test(head)) return null;

  const extraFields = options.extraFields && typeof options.extraFields === 'object' ? options.extraFields : {};
  const hasExtraFields = Object.keys(extraFields).length > 0;
  if (options.gzip) {
    const withMetadata = hasExtraFields ? appendCacheHit(buffer, cacheHit, extraFields) : null;
    const body = withMetadata ? gzipSync(withMetadata, {level: 6}) : await readOrCreateGzipCache(file, buffer);
    return {
      body,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': String(body.length),
        'Vary': 'Accept-Encoding',
        'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
        'X-BI-Section-Mode': hasExtraFields ? 'raw-cache-gzip-meta' : 'raw-cache-gzip',
        ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
      },
    };
  }

  const body = appendCacheHit(buffer, cacheHit, extraFields);
  if (!body) return null;
  return {
    body,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-BI-Section-Cache-Hit': cacheHit ? 'true' : 'false',
      'X-BI-Section-Mode': 'raw-cache',
      ...(extraFields.staleSection ? {'X-BI-Section-Stale': 'true'} : {}),
    },
  };
}

export async function readBiSectionStaleRaw(root, section, currentGeneratedAt, options = {}) {
  const stale = await readBiSectionCacheRaw(root, section, '', true, {
    ...options,
    extraFields: {
      staleSection: true,
      cacheStale: true,
      refreshScheduled: Boolean(options.refreshScheduled),
      coreGeneratedAt: String(currentGeneratedAt || ''),
    },
  });
  if (!stale) return null;
  return {
    body: stale.body,
    headers: {...stale.headers, 'X-BI-Section-Stale': 'true', 'Cache-Control': 'no-store'},
  };
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
  await writeBufferFileAtomic(file, raw);
  try {
    await writeGzipCache(file, raw);
  } catch (error) {
    (options.onGzipError || console.warn)('BI section gzip cache write failed', section, error?.message || error);
  }
  return payload;
}
