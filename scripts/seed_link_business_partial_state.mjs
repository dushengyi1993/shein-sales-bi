#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

import {mergeLinkBusinessPartialState} from '../lib/cloud_manual_login_recovery.mjs';

const partialFile = String(process.env.SEED_PARTIAL_FILE || '').trim();
if (!partialFile) throw new Error('SEED_PARTIAL_FILE is required');

let plan;
try {
  plan = JSON.parse(String(process.env.SEED_PARTIAL_PLAN || ''));
} catch {
  throw new Error('SEED_PARTIAL_PLAN must be valid JSON');
}

try {
  await fs.access(partialFile);
  console.log(JSON.stringify({seeded: false, reason: 'canonical_exists'}));
  process.exit(17);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const canonical = mergeLinkBusinessPartialState({
  existing: null,
  date: plan.date,
  failedStores: plan.failedStores,
  successStores: plan.successStores,
  logFile: plan.logFile,
  recoveryRunId: plan.recoveryRunId,
});
await fs.mkdir(path.dirname(partialFile), {recursive: true});
const temporary = `${partialFile}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
await fs.rename(temporary, partialFile);
