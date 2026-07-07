#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'split-limited-target-guard-'));
const planPath = path.join(tmp, 'split-plan.json');

await fs.writeFile(planPath, `${JSON.stringify({
  storeKey: 'NM',
  oldActivity: {id: 12345},
  groups: [{
    group: 'below',
    endTime: '2026-07-21 23:59:59',
    activityNamePrefix: 'smoke',
    rows: [{
      skc: 'sv-below',
      limitedDiscountPrice: 105.77,
      finalTargetPrice: 111.99,
      canonical: 'SM-505A电动缝纫机',
    }],
  }],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/split_recreate_mixed_limited_discount.mjs',
  '--plan', planPath,
  '--store', 'NM',
  '--port', '9',
], {encoding: 'utf8'});

assert.notEqual(result.status, 0, 'split/recreate must fail before CDP connect when price is below target');
assert.match(result.stderr + result.stdout, /price below finalTargetPrice|too-deep fallback/);

console.log(JSON.stringify({ok: true, test: 'split_limited_discount_refuses_price_below_final_target'}));
