#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./cloud_bi_refresh.sh', import.meta.url), 'utf8');
const dailySource = await fs.readFile(new URL('./cloud_daily_refresh.sh', import.meta.url), 'utf8');

assert.match(
  source,
  /nohup\s+bash\s+scripts\/prewarm_bi_portal_sections\.sh\s+8>&-\s+9>&-\s+>\/dev\/null\s+2>&1\s+&/,
  'background portal prewarm must close both inherited lock descriptors',
);

assert.match(
  dailySource,
  /nohup\s+bash\s+scripts\/prewarm_bi_portal_sections\.sh\s+8>&-\s+>\/dev\/null\s+2>&1\s+&/,
  'daily background portal prewarm must close its inherited portal lock descriptor',
);

console.log('cloud_bi_refresh_lock_handoff: checks passed');
