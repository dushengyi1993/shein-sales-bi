import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {claimRetireReviewDelivery} from '../lib/link_retire_review_delivery_guard.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-review-claim-'));
try {
  const args = {root, date:'2026-09-07', fingerprint:'a'.repeat(64)};
  const concurrent = await Promise.allSettled([claimRetireReviewDelivery(args), claimRetireReviewDelivery(args)]);
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length, 1);
  await assert.rejects(claimRetireReviewDelivery({...args, fingerprint:'b'.repeat(64)}));
  const day = path.join(root, '2026-09-08');
  await fs.mkdir(path.join(day, 'c'.repeat(64)), {recursive:true});
  await assert.rejects(claimRetireReviewDelivery({...args,date:'2026-09-08'}), /already has delivery evidence/);
  console.log('PASS retire review day claim: concurrent, unknown, changed attachment, legacy evidence');
} finally { await fs.rm(root, {recursive:true,force:true}); }
