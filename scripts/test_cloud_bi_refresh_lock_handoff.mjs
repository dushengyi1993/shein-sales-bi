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

assert.match(source, /marketing_price_snapshot_health\(\)/,
  'cloud refresh must publish an inspectable marketing-price freshness state');
assert.match(source, /node scripts\/marketing\/export_marketing_price_leads_for_bi\.mjs\nMARKETING_PRICE_SNAPSHOT_HEALTH=/,
  'marketing export failures must not be swallowed before the freshness state is inspected');
assert.doesNotMatch(source, /export_marketing_price_leads_for_bi\.mjs \|\| true/,
  'old marketing price evidence may be retained only with explicit stale/error metadata, not a silent success');
assert.match(source, /SHEIN_BI_MARKETING_PRICE_LEADS_REQUIRE_FRESH/,
  'operators must be able to require fresh marketing-price evidence for a strict health gate');

console.log('cloud_bi_refresh_lock_handoff: lock handoff and marketing snapshot health checks passed');
