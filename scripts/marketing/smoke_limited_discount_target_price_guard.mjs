#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'limited-discount-target-guard-'));
const rescuePath = path.join(tmp, 'rescue-below-target.json');

await fs.writeFile(rescuePath, `${JSON.stringify({
  rows: [
    {
      storeKey: 'NM',
      skc: 'sv-below',
      needsLimitedDiscount: true,
      limitedDiscountPrice: 105.77,
      finalTargetPrice: 111.99,
      targetPrice: 111.99,
      canonical: 'SM-505A电动缝纫机',
    },
  ],
}, null, 2)}\n`, 'utf8');

const result = spawnSync(process.execPath, [
  'scripts/marketing/apply_hl_limited_discount_rescue.mjs',
  '--store', 'NM',
  '--rescue', rescuePath,
  '--end-time', '2026-07-21 23:59:59',
], {encoding: 'utf8'});

assert.notEqual(result.status, 0, 'below-target rescue must fail before any browser/write path');
assert.match(result.stderr + result.stdout, /below finalTargetPrice|refusing mechanical 15%/);

console.log(JSON.stringify({ok: true, test: 'limited_discount_rescue_refuses_price_below_final_target'}));
