#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const source = await fs.readFile('scripts/cloud_marketing_repair_worker.sh', 'utf8');
const highClick = source.slice(
  source.indexOf('HIGH_CLICK_STATUS='),
  source.indexOf('MANUAL_STATUS='),
);
const fallback = source.slice(
  source.indexOf('FALLBACK_STATUS='),
  source.indexOf('QUEUE_STATUS=', source.indexOf('FALLBACK_STATUS=')),
);

assert.match(highClick, /--max-items 1/);
assert.match(highClick, /"\$status" -eq 4 && "\$PROCESSED_ITEMS" == "0"/);
assert.match(highClick, /recoverable items were attempted once in this service run/);
assert.match(highClick, /continuing independent repair stages/);
assert.match(highClick, /\n\s+break\n/);

assert.match(fallback, /while \(\( REMAINING_GROUPS > 0 \)\)/);
assert.match(fallback, /begin_stage_critical_section fallbackRepair/);
assert.match(fallback, /--skip-build --execute --max-groups 1/);
assert.match(fallback, /update_stage fallbackRepair pending/);
assert.match(fallback, /consume_group_budget "\$PROCESSED_GROUPS"/);
assert.doesNotMatch(fallback, /--max-groups "\$REMAINING_GROUPS"/);

function toBashPath(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

const root = toBashPath(process.cwd());
const oldQueueProbe = spawnSync('bash', [], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: process.env,
  input: [
    `export SHEIN_BI_ROOT='${root}'`,
    "export SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION='local'",
    "export SHEIN_BI_MARKETING_REPAIR_DATE='2000-01-01'",
    `bash '${root}/scripts/cloud_marketing_repair_worker.sh'`,
    '',
  ].join('\n'),
});
assert.equal(oldQueueProbe.status, 75);
assert.match(oldQueueProbe.stderr, /refusing non-current repair queue/);

console.log(JSON.stringify({ok: true, checks: 13}, null, 2));
