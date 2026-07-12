#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = (await fs.readFile(path.join(ROOT, 'infra', 'warehouse', 'migrations', '20260711_001_link_ops_runtime.sql'), 'utf8'))
  .replace(/\r\n/g, '\n')
  .trim();
const schema = (await fs.readFile(path.join(ROOT, 'infra', 'warehouse', 'schema.sql'), 'utf8')).replace(/\r\n/g, '\n');
const match = schema.match(/-- BEGIN LINK OPS ROW-LEVEL RUNTIME[^\n]*\n([\s\S]*?)\n-- END LINK OPS ROW-LEVEL RUNTIME/);
assert.ok(match, 'canonical warehouse schema must embed the Link Ops migration block');
assert.equal(match[1].trim(), migration, 'canonical schema Link Ops block must exactly mirror the migration SQL');

for (const marker of [
  'ops.link_ops_session',
  'ops.link_ops_message',
  'ops.link_ops_task',
  'ops.link_ops_job',
  'ops.link_ops_event',
  'ops.link_ops_idempotency',
  'link_ops_event_append_only',
]) {
  assert.match(migration, new RegExp(marker.replaceAll('.', '\\.')));
}

console.log('link_ops_schema_sync: canonical schema and row-level migration are identical');
