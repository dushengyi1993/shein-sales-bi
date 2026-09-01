#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gunzipSync, gzipSync} from 'node:zlib';
import {
  biSectionIdentityMatches,
  getBiSectionOpenStreamCount,
  readBiSectionMetadata,
  readBiSectionRawStream,
  readBiSectionStaleRaw,
  writeBiSectionCache,
} from '../lib/bi_section_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATION = 'gen-2026-08-17';
const LARGE_SECTION = 'profitStreaming';
const BI_SECTION_HEAD_COUNTEREXAMPLE_BYTES = 12 * 1024;

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function smallSectionPayload(section, generatedAt, rows) {
  return JSON.stringify({
    ok: true,
    section,
    generatedAt,
    cachedAt: '2026-08-17T00:00:00.000Z',
    data: {rows},
  }) + '\n';
}

async function readIntegritySidecar(rawFile) {
  return JSON.parse(await fs.readFile(rawFile + '.integrity.json', 'utf8'));
}

function buildLargePayload(count, options = {}) {
  let text = '{"ok":true,"section":"' + (options.section || 'profit') + '","generatedAt":"' + GENERATION
    + '","cachedAt":"2026-08-17T00:00:00.000Z","data":{"profit":{"dailyStoreProducts":[';
  for (let i = 0; i < count; i += 1) {
    if (i > 0) text += ',';
    if (options.chineseTail && i === count - 1) {
      text += '{"date":"2026-08-17","store_key":"ST9","standard_goods_sn":"P9999999","net_revenue_sar":9,"note":"' + '中文'.repeat(1400) + '"}';
    } else {
      text += '{"date":"2026-08-17","store_key":"ST' + (i % 19) + '","standard_goods_sn":"P' + String(i).padStart(7, '0')
        + '","net_revenue_sar":' + (i * 37) + ',"note":"' + 'w'.repeat(options.noteLength || 92) + '"}';
    }
  }
  text += ']}}}';
  return text + (options.trailing || '');
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-section-streaming-'));
try {
  const sectionsDir = path.join(tmp, 'sections');
  await fs.mkdir(sectionsDir, {recursive: true});
  const bigFile = path.join(sectionsDir, `${LARGE_SECTION}.json`);
  // ~96MB synthetic profit cache (near the historical 98MB production bound).
  const rowCount = 520000;
  const payload = buildLargePayload(rowCount, {section: LARGE_SECTION, trailing: '\n\n  \n'});
  assert.ok(Buffer.byteLength(payload, 'utf8') >= 88 * 1024 * 1024,
    'fixture must be near-limit 88MB+, got ' + Buffer.byteLength(payload, 'utf8'));
  await fs.writeFile(bigFile, payload, 'utf8');

  // ---- Bounded metadata/identity API on the near-limit artifact ------------
  const meta = await readBiSectionMetadata(tmp, LARGE_SECTION);
  assert.ok(meta && meta.ok === true, 'bounded metadata must resolve');
  assert.equal(meta.generatedAt, GENERATION);
  assert.equal(meta.hasData, true);
  assert.ok(meta.size >= 88 * 1024 * 1024);
  assert.equal(meta.cacheKey,
    [path.resolve(tmp), LARGE_SECTION, GENERATION, meta.cachedAt, meta.size, meta.mtimeMs].join('|'),
    'metadata cacheKey must mirror the artifact identity contract');
  assert.equal((await readBiSectionMetadata(tmp, 'missing')), null, 'missing section metadata is null');

  assert.equal(await biSectionIdentityMatches(tmp, LARGE_SECTION, GENERATION), true);
  assert.equal(await biSectionIdentityMatches(tmp, LARGE_SECTION, 'gen-other'), false);
  const bigIntegrity = await readIntegritySidecar(bigFile);
  assert.equal(bigIntegrity.version, 1, 'integrity sidecar schema must be versioned');
  assert.equal(bigIntegrity.section, LARGE_SECTION);
  assert.equal(bigIntegrity.generatedAt, GENERATION);
  assert.equal(bigIntegrity.raw.byteSize, meta.size);
  assert.match(bigIntegrity.raw.sha256, /^[a-f0-9]{64}$/);
  assert.match(bigIntegrity.gzip.sha256, /^[a-f0-9]{64}$/);
  assert.equal(bigIntegrity.gzip.sourceRawSha256, bigIntegrity.raw.sha256);
  assert.equal(bigIntegrity.gzip.sourceGenerationIdentity, bigIntegrity.generationIdentity);
  assert.equal(typeof bigIntegrity.raw.stat.inode, 'string');
  assert.equal(typeof bigIntegrity.raw.stat.mtimeNs, 'string');
  assert.equal(typeof bigIntegrity.raw.stat.ctimeNs, 'string');

  // ---- Identity stream with tail cacheHit/extraFields ----------------------
  const identityOptions = {extraFields: {cacheStale: true, coreGeneratedAt: 'gen-other'}};
  const identity = await readBiSectionRawStream(tmp, LARGE_SECTION, GENERATION, true, identityOptions);
  assert.ok(identity, 'identity stream descriptor required');
  assert.equal(identity.headers['X-BI-Section-Mode'], 'raw-cache');
  assert.equal(identity.headers['Content-Length'], undefined, 'streamed identity must not claim a precomputed length');
  const identityBytes = await collect(identity.stream);
  const identityPayload = JSON.parse(identityBytes.toString('utf8'));
  assert.equal(identityPayload.cacheHit, true);
  assert.equal(identityPayload.cacheStale, true);
  assert.equal(identityPayload.coreGeneratedAt, 'gen-other');
  assert.equal(identityPayload.data.profit.dailyStoreProducts.length, rowCount);

  // ---- gzip with the same metadata decodes byte-identical -----------------
  const gzMeta = await readBiSectionRawStream(tmp, LARGE_SECTION, GENERATION, true, {
    gzip: true,
    extraFields: identityOptions.extraFields,
  });
  assert.ok(gzMeta, 'gzip stream descriptor required');
  assert.equal(gzMeta.headers['Content-Encoding'], 'gzip');
  assert.equal(gzMeta.headers['X-BI-Section-Mode'], 'raw-cache-gzip-meta');
  assert.equal(gzMeta.headers['Content-Length'], undefined, 'live-compressed gzip must not claim a precomputed length');
  assert.deepEqual(gunzipSync(await collect(gzMeta.stream)), identityBytes,
    'gzip metadata variant must decode byte-identical to the identity metadata variant');

  // ---- Generation mismatch fails closed on both encodings -----------------
  assert.equal(await readBiSectionRawStream(tmp, LARGE_SECTION, 'gen-other', true), null);
  assert.equal(await readBiSectionRawStream(tmp, LARGE_SECTION, 'gen-other', true, {gzip: true}), null);
  const stale = await readBiSectionStaleRaw(tmp, LARGE_SECTION, 'gen-other', {gzip: true, refreshScheduled: true});
  assert.ok(stale, 'stale raw must serve any-generation artifact with stale metadata');
  const stalePayload = JSON.parse(gunzipSync(await collect(stale.stream)).toString('utf8'));
  assert.equal(stalePayload.staleSection, true);
  assert.equal(stalePayload.coreGeneratedAt, 'gen-other');
  assert.equal(stale.headers['Cache-Control'], 'no-store');

  // ---- Tail boundary variants ----------------------------------------------
  await fs.writeFile(path.join(sectionsDir, 'edge.json'), buildLargePayload(250, {section: 'edge'}), 'utf8');
  const edgeStream = await readBiSectionRawStream(tmp, 'edge', GENERATION, false);
  assert.ok(edgeStream, 'edge fixture must stream');
  const edgeParsed = JSON.parse((await collect(edgeStream.stream)).toString('utf8'));
  assert.equal(edgeParsed.cacheHit, false);
  assert.equal(edgeParsed.data.profit.dailyStoreProducts.length, 250);

  // A chineseTail variant puts a multibyte run adjacent to the closing brace
  // so the bounded tail window starts inside a multi-byte UTF-8 sequence.
  await fs.writeFile(path.join(sectionsDir, 'utf8.json'),
    buildLargePayload(300, {section: 'utf8', chineseTail: true, trailing: ' '}), 'utf8');
  const utf8Options = {extraFields: {cacheStale: true}};
  const utf8Identity = await readBiSectionRawStream(tmp, 'utf8', GENERATION, true, utf8Options);
  assert.ok(utf8Identity, 'utf8 fixture must stream');
  const utf8Bytes = await collect(utf8Identity.stream);
  const utf8Parsed = JSON.parse(utf8Bytes.toString('utf8'));
  assert.equal(utf8Parsed.cacheHit, true);
  assert.equal(utf8Parsed.data.profit.dailyStoreProducts[299].note.startsWith('中文'), true);
  const utf8Gzip = await readBiSectionRawStream(tmp, 'utf8', GENERATION, true, {gzip: true, extraFields: utf8Options.extraFields});
  assert.ok(utf8Gzip);
  assert.deepEqual(gunzipSync(await collect(utf8Gzip.stream)), utf8Bytes,
    'gzip/identity must agree even when the tail window splits a multibyte char');

  // ---- Invalid head/tail fail closed ---------------------------------------
  await fs.writeFile(path.join(sectionsDir, 'noData.json'),
    '{"ok":true,"section":"noData","generatedAt":"' + GENERATION + '","cachedAt":"c","other":1}\n', 'utf8');
  assert.equal(await readBiSectionRawStream(tmp, 'noData', GENERATION, true), null, 'missing data key fails closed');
  await fs.writeFile(path.join(sectionsDir, 'badTail.json'),
    '{"ok":true,"section":"badTail","generatedAt":"' + GENERATION + '","cachedAt":"c","data":{"a":1},', 'utf8');
  assert.equal(await readBiSectionRawStream(tmp, 'badTail', GENERATION, true), null, 'truncated tail fails closed');

  // A syntactically plausible head and closing tail must not conceal a corrupt
  // middle. This was the specific hole in the former head/tail-only check.
  const corruptMiddleFile = path.join(sectionsDir, 'corruptMiddle.json');
  const corruptMiddle = '{"ok":true,"section":"corruptMiddle","generatedAt":"' + GENERATION
    + '","cachedAt":"2026-08-17T00:00:00.000Z","data":{"rows":[{"note":"'
    + 'x'.repeat(BI_SECTION_HEAD_COUNTEREXAMPLE_BYTES) + '"},not_json,{"id":2}]}}\n';
  await fs.writeFile(corruptMiddleFile, corruptMiddle, 'utf8');
  assert.ok(Buffer.byteLength(corruptMiddle) > 8 * 1024, 'corruption must sit beyond the bounded metadata head');
  assert.equal(await readBiSectionRawStream(tmp, 'corruptMiddle', GENERATION, true), null,
    'valid head/tail with a corrupt middle must fail closed');
  assert.equal(await readBiSectionRawStream(tmp, 'corruptMiddle', GENERATION, true, {gzip: true}), null,
    'a corrupt raw must never be masked by a gzip response');

  // A newer mtime is not a generation binding. Seed an old-generation gzip
  // beside a current raw and prove the old bytes are never served.
  const rolloverFile = path.join(sectionsDir, 'rollover.json');
  const rolloverGeneration = 'gen-rollover-current';
  const rolloverRaw = smallSectionPayload('rollover', rolloverGeneration, [{id: 'current'}]);
  const oldRolloverRaw = smallSectionPayload('rollover', 'gen-rollover-old', [{id: 'old'}]);
  const oldRolloverGzip = gzipSync(oldRolloverRaw);
  await fs.writeFile(rolloverFile, rolloverRaw, 'utf8');
  await fs.writeFile(rolloverFile + '.gz', oldRolloverGzip);
  const futureMtime = new Date(Date.now() + 60_000);
  await fs.utimes(rolloverFile + '.gz', futureMtime, futureMtime);
  const [rolloverRawStat, rolloverGzipStat] = await Promise.all([
    fs.stat(rolloverFile),
    fs.stat(rolloverFile + '.gz'),
  ]);
  assert.ok(rolloverGzipStat.mtimeMs > rolloverRawStat.mtimeMs,
    'counterexample requires the stale gzip mtime to look newer');
  const rollover = await readBiSectionRawStream(tmp, 'rollover', rolloverGeneration, true, {gzip: true});
  assert.ok(rollover, 'validated raw may regenerate a bound gzip');
  const rolloverBytes = await collect(rollover.stream);
  const rolloverParsed = JSON.parse(gunzipSync(rolloverBytes).toString('utf8'));
  assert.equal(rolloverParsed.generatedAt, rolloverGeneration);
  assert.equal(rolloverParsed.data.rows[0].id, 'current');
  assert.notEqual(sha256(rolloverBytes), sha256(oldRolloverGzip),
    'old-generation gzip bytes must not be served even with a newer mtime');
  let rolloverIntegrity = await readIntegritySidecar(rolloverFile);
  assert.equal(rolloverIntegrity.raw.sha256, sha256(Buffer.from(rolloverRaw)));
  assert.equal(rolloverIntegrity.gzip.sha256, sha256(rolloverBytes));

  // Byte-tamper a previously bound gzip, then restore its old mtime. The
  // stable stat identity still changes, so the tampered bytes leave the fast
  // path and a gzip is regenerated from the revalidated raw.
  const boundGzip = await fs.readFile(rolloverFile + '.gz');
  const boundGzipStat = await fs.stat(rolloverFile + '.gz');
  const tamperedGzip = Buffer.from(boundGzip);
  tamperedGzip[Math.floor(tamperedGzip.length / 2)] ^= 0x01;
  await fs.writeFile(rolloverFile + '.gz', tamperedGzip);
  await fs.utimes(rolloverFile + '.gz', boundGzipStat.atime, boundGzipStat.mtime);
  const repairedGzip = await readBiSectionRawStream(tmp, 'rollover', rolloverGeneration, true, {gzip: true});
  assert.ok(repairedGzip, 'gzip tamper may recover only through raw revalidation');
  const repairedGzipBytes = await collect(repairedGzip.stream);
  assert.equal(JSON.parse(gunzipSync(repairedGzipBytes).toString('utf8')).data.rows[0].id, 'current');
  assert.notEqual(sha256(repairedGzipBytes), sha256(tamperedGzip), 'tampered gzip bytes must never be served');
  rolloverIntegrity = await readIntegritySidecar(rolloverFile);
  assert.equal(rolloverIntegrity.gzip.sha256, sha256(repairedGzipBytes),
    'repaired sidecar must bind the exact published gzip bytes');

  // A structurally valid sidecar from another artifact is still a mismatch;
  // a direct sidecar-byte tamper also invalidates the binding hash. Neither may
  // authorize a fast-path response.
  await writeBiSectionCache(tmp, 'sidecarTarget', 'gen-sidecar-target', {rows: [{id: 'target'}]}, null);
  await writeBiSectionCache(tmp, 'sidecarForeign', 'gen-sidecar-foreign', {rows: [{id: 'foreign'}]}, null);
  const sidecarTargetFile = path.join(sectionsDir, 'sidecarTarget.json');
  const sidecarForeignFile = path.join(sectionsDir, 'sidecarForeign.json');
  await fs.copyFile(sidecarForeignFile + '.integrity.json', sidecarTargetFile + '.integrity.json');
  const sidecarMismatch = await readBiSectionRawStream(tmp, 'sidecarTarget', 'gen-sidecar-target', true);
  assert.ok(sidecarMismatch, 'a valid raw may repair a mismatched sidecar');
  assert.equal(JSON.parse((await collect(sidecarMismatch.stream)).toString('utf8')).data.rows[0].id, 'target');
  let repairedSidecar = await readIntegritySidecar(sidecarTargetFile);
  assert.equal(repairedSidecar.section, 'sidecarTarget');
  assert.equal(repairedSidecar.generatedAt, 'gen-sidecar-target');

  repairedSidecar.gzip.sha256 = '0'.repeat(64);
  await fs.writeFile(sidecarTargetFile + '.integrity.json', JSON.stringify(repairedSidecar) + '\n', 'utf8');
  const sidecarTamper = await readBiSectionRawStream(tmp, 'sidecarTarget', 'gen-sidecar-target', true, {gzip: true});
  assert.ok(sidecarTamper, 'a sidecar binding tamper may recover only after raw validation');
  assert.equal(JSON.parse(gunzipSync(await collect(sidecarTamper.stream)).toString('utf8')).data.rows[0].id, 'target');
  repairedSidecar = await readIntegritySidecar(sidecarTargetFile);
  assert.notEqual(repairedSidecar.gzip.sha256, '0'.repeat(64));
  assert.equal(repairedSidecar.raw.sha256, sha256(await fs.readFile(sidecarTargetFile)));

  // ---- Existing .gz sibling is streamed directly ---------------------------
  const written = await writeBiSectionCache(tmp, 'small', 'g1', {rows: [{id: 1}]}, {code: 0, timedOut: false, stderr: 'ok'});
  assert.equal(written.section, 'small');
  const gzFileBytes = await fs.readFile(path.join(sectionsDir, 'small.json.gz'));
  const direct = await readBiSectionRawStream(tmp, 'small', 'g1', true, {gzip: true});
  assert.ok(direct, 'existing gzip sibling descriptor required');
  assert.equal(direct.headers['Content-Encoding'], 'gzip');
  assert.equal(direct.headers['X-BI-Section-Mode'], 'raw-cache-gzip');
  assert.equal(direct.headers['Content-Length'], String(gzFileBytes.length));
  assert.deepEqual(await collect(direct.stream), gzFileBytes, 'a fresh .gz is served without recompression');

  // ---- fd release on early cancellation ------------------------------------
  const preOpen = getBiSectionOpenStreamCount();
  const drop = await readBiSectionRawStream(tmp, LARGE_SECTION, GENERATION, true, {
    gzip: true,
    extraFields: {cacheStale: true},
  });
  assert.ok(drop);
  assert.equal(getBiSectionOpenStreamCount(), preOpen + 1, 'a live gzip stream owns exactly one section handle');
  await drop.stream.destroy();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(getBiSectionOpenStreamCount(), preOpen, 'destroying the gzip stream must release the section handle');

  const dropIdentity = await readBiSectionRawStream(tmp, LARGE_SECTION, GENERATION, true);
  assert.equal(getBiSectionOpenStreamCount(), preOpen + 1, 'a live identity stream owns exactly one section handle');
  await dropIdentity.stream.destroy();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(getBiSectionOpenStreamCount(), preOpen, 'early identity cancellation must release the handle');

  // ---- Small-heap child probe with a slow client and mid-stream abort ------
  // The child runs under a 96MB old-space ceiling while streaming a ~96MB
  // artifact. It computes gzip/identity hashes incrementally so it never holds
  // the full document, forces backpressure with a deliberately slow client,
  // and aborts a third request mid-stream to prove fd release. Remove both
  // derived artifacts so the 96MB-heap child must execute the complete cold
  // validation + gzip + sidecar path, not merely trust the parent's fast path.
  await fs.rm(bigFile + '.integrity.json', {force: true});
  await fs.rm(bigFile + '.gz', {force: true});
  const probeLines = [
    "import assert from 'node:assert/strict';",
    "import http from 'node:http';",
    "import zlib from 'node:zlib';",
    "import crypto from 'node:crypto';",
    "import path from 'node:path';",
    "import {pipeline} from 'node:stream/promises';",
    "import {pathToFileURL} from 'node:url';",
    '',
    "const [root, repoRoot, section, generation] = process.argv.slice(1);",
    "const lib = await import(pathToFileURL(path.join(repoRoot, 'lib', 'bi_section_cache.mjs')).href);",
    'let peakDeltaHeap = 0;',
    'let baselineHeap = 0;',
    'const sample = () => {',
    '  const heap = process.memoryUsage().heapUsed;',
    '  if (heap - baselineHeap > peakDeltaHeap) peakDeltaHeap = heap - baselineHeap;',
    '};',
    'await new Promise(resolve => setTimeout(resolve, 80));',
    'if (global.gc) global.gc();',
    'baselineHeap = process.memoryUsage().heapUsed;',
    '',
    'const toBuffer = chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);',
    '',
    'const server = http.createServer(async (req, res) => {',
    "  const gzipRequested = String(req.headers['accept-encoding'] || '').includes('gzip');",
    '  const desc = await lib.readBiSectionRawStream(root, section, generation, true, {',
    '    gzip: gzipRequested,',
    "    extraFields: {cacheStale: true, coreGeneratedAt: 'gen-other'},",
    '  });',
    '  if (!desc) {',
    "    res.writeHead(503, {'Content-Type': 'application/json'});",
    "    res.end('{\"ok\":false}');",
    '    return;',
    '  }',
    '  res.writeHead(200, desc.headers);',
    '  pipeline(desc.stream, res).catch(() => {});',
    '});',
    '',
    'function hashRequest(port, accept, sampling) {',
    '  return new Promise((resolve, reject) => {',
    "    const hash = crypto.createHash('sha256');",
    '    let bytes = 0;',
    "    const req = http.request({host: '127.0.0.1', port, path: '/', headers: {'accept-encoding': accept}}, res => {",
    "      const gunzip = accept === 'gzip' ? zlib.createGunzip() : null;",
    "      const emit = part => { const buf = toBuffer(part); hash.update(buf); bytes += buf.length; sampling(); };",
    "      res.on('data', chunk => {",
    '        res.pause();',
    '        if (gunzip) gunzip.write(chunk);',
    '        else emit(chunk);',
    '        setImmediate(() => res.resume());',
    '      });',
    "      gunzip && gunzip.on('data', part => emit(part));",
    "      res.on('end', () => { if (gunzip) gunzip.end(); });",
    "      gunzip && gunzip.on('end', () => resolve({sha: hash.digest('hex'), bytes}));",
    "      !gunzip && res.on('end', () => resolve({sha: hash.digest('hex'), bytes}));",
    "      res.on('error', reject);",
    "      gunzip && gunzip.on('error', reject);",
    '    });',
    "    req.on('error', reject);",
    '    req.end();',
    '  });',
    '}',
    '',
    'function abortRequest(port, accept, sampling) {',
    '  return new Promise(resolve => {',
    "    const req = http.request({host: '127.0.0.1', port, path: '/', headers: {'accept-encoding': accept}}, res => {",
    '      let read = 0;',
    "      res.on('data', chunk => {",
    '        read += 1;',
    '        sampling();',
    '        if (read >= 3) {',
    '          req.destroy();',
    '          res.destroy();',
    '          setTimeout(resolve, 200);',
    '        }',
    '      });',
    "      res.on('error', () => {});",
    "      res.on('close', () => {});",
    '    });',
    "    req.on('error', () => {});",
    '    req.end();',
    '  });',
    '}',
    '',
    "server.listen(0, '127.0.0.1', async () => {",
    '  try {',
    '    const port = server.address().port;',
    "    const identity = await hashRequest(port, 'identity', sample);",
    "    const gzip = await hashRequest(port, 'gzip', sample);",
    "    assert.equal(identity.sha, gzip.sha, 'gzip decode must equal identity bytes under a small heap');",
    "    await abortRequest(port, 'gzip', sample);",
    '    let wait = 0;',
    '    while (lib.getBiSectionOpenStreamCount() > 0 && wait < 30) {',
    '      await new Promise(r => setTimeout(r, 50));',
    '      wait += 1;',
    '    }',
    '    await new Promise(resolve => setTimeout(resolve, 250));',
    '    const openCountAfterAbort = lib.getBiSectionOpenStreamCount();',
    '    const openCountFinal = lib.getBiSectionOpenStreamCount();',
    '    server.close();',
    '    process.stdout.write(JSON.stringify({',
    '      ok: true,',
    '      gzipIdentityEqual: identity.sha === gzip.sha,',
    '      identitySha: identity.sha.slice(0, 16),',
    '      gzipSha: gzip.sha.slice(0, 16),',
    '      identityBytes: identity.bytes,',
    '      gzipBytes: gzip.bytes,',
    '      peakHeapDeltaMb: Number((peakDeltaHeap / (1024 * 1024)).toFixed(2)),',
    '      openCountAfterAbort,',
    '      openCountFinal,',
    "    }) + '\\n');",
    '  } catch (error) {',
    '    server.close();',
    "    process.stdout.write(JSON.stringify({ok: false, error: String(error && error.stack || error)}) + '\\n');",
    '    process.exit(2);',
    '  }',
    '});',
  ];
  const childProbe = probeLines.join('\n');
  const childResult = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--max-old-space-size=96', '--expose-gc', '--input-type=module', '-e', childProbe,
      path.resolve(tmp), ROOT, LARGE_SECTION, GENERATION,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({status, signal, stdout, stderr}));
  });
  assert.equal(childResult.status, 0, 'small-heap probe must exit 0\nstderr=' + childResult.stderr + '\nstdout=' + childResult.stdout);
  const probe = JSON.parse(childResult.stdout.trim().split('\n').pop());
  assert.equal(probe.ok, true, JSON.stringify(probe));
  assert.equal(probe.gzipIdentityEqual, true, 'gzip decode must equal identity bytes under a small heap');
  assert.ok(probe.peakHeapDeltaMb < 48,
    'streaming/bounded reads must stay under a 48MB heap delta, got ' + probe.peakHeapDeltaMb + 'MB on a ' + meta.size + ' byte fixture');
  assert.equal(probe.openCountFinal, 0, 'all section handles must be released after the small-heap probes');
  assert.equal(probe.openCountAfterAbort, 0, 'a mid-stream client abort must release the section handle');
  const childIntegrity = await readIntegritySidecar(bigFile);
  assert.equal(childIntegrity.raw.byteSize, meta.size, 'small-heap cold path must publish the complete raw identity');
  assert.equal(childIntegrity.gzip.sourceRawSha256, childIntegrity.raw.sha256);

  console.log('bi_section_streaming: full syntax, sidecar/gzip integrity counterexamples, fd release, near-limit cold small-heap, and abort evidence passed');
} finally {
  await fs.rm(tmp, {recursive: true, force: true});
}
