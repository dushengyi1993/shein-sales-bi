#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeFileAtomic, writeJsonFileAtomic} from '../lib/atomic_file_publish.mjs';

const sectionCacheSource = await fs.readFile(new URL('../lib/bi_section_cache.mjs', import.meta.url), 'utf8');
assert.match(sectionCacheSource, /writeFileAtomic\(file, raw\)/,
  'section JSON cache must use the durable atomic publisher');
assert.match(sectionCacheSource, /writeFileAtomic\(`\$\{file\}\.gz`, gzipped\)/,
  'section gzip cache must use the durable atomic publisher');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-bi-atomic-publish-'));
const target = path.join(dir, 'data.json');
try {
  await fs.writeFile(target, '{"version":"old"}\n', 'utf8');
  await assert.rejects(
    () => writeFileAtomic(target, '{"version":"new"}\n', {
      encoding: 'utf8',
      beforeRename: async () => { throw new Error('injected rename boundary failure'); },
    }),
    /injected rename boundary failure/,
  );
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'old'}, 'a failed publish must keep the prior complete artifact');
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0, 'failed temporary artifacts must be cleaned up');

  await writeJsonFileAtomic(target, {version: 'new', complete: true});
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), {version: 'new', complete: true}, 'a successful publish must expose one complete JSON artifact');
} finally {
  await fs.rm(dir, {recursive: true, force: true});
}

console.log('atomic_file_publish: fsync/rename publish preserves previous complete artifacts on injected failure');
