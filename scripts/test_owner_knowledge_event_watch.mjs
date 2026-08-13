#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner_knowledge_sync.mjs');
for (const command of ['scan', 'sync', 'watch']) {
  const result = spawnSync(process.execPath, [script, command], {encoding: 'utf8'});
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /旧会话扫描采集器已废弃/);
}
console.log(JSON.stringify({ok: true, suite: 'owner_knowledge_scanner_retired'}));
