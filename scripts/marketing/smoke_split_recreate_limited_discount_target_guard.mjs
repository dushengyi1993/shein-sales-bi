#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'split-recreate-target-guard-'));
const planPath = path.join(tmp, 'mixed-plan.json');
await fs.writeFile(planPath, `${JSON.stringify({
  storeKey: 'NM',
  oldActivity: {id: 123},
  groups: [{
    group: 'below-target',
    endTime: '2026-07-21 23:59:59',
    activityNamePrefix: 'smoke',
    rows: [{
      skc: 'sv-below',
      limitedDiscountPrice: 95,
      finalTargetPrice: 100,
    }],
  }],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/split_recreate_mixed_limited_discount.mjs',
  '--plan', planPath,
  '--store-key', 'NM',
  '--port', '1',
], {encoding: 'utf8'});

assert.notEqual(result.status, 0);
assert.match(result.stderr + result.stdout, /below finalTargetPrice|refusing mechanical 15%/);
assert.doesNotMatch(result.stderr + result.stdout, /ECONNREFUSED|No page at|CDP/i);

console.log(JSON.stringify({ok: true, test: 'split_recreate_refuses_limited_discount_below_final_target_before_browser'}));
