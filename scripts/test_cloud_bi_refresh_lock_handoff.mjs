#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./cloud_bi_refresh.sh', import.meta.url), 'utf8');
const dailySource = await fs.readFile(new URL('./cloud_daily_refresh.sh', import.meta.url), 'utf8');

assert.match(
  source,
  /bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections homeRankings,afterSales,orders,homeProfit/,
  'sales refresh must enqueue priority Portal sections instead of detaching a generator',
);
assert.doesNotMatch(
  source,
  /nohup\s+bash\s+scripts\/prewarm_bi_portal_sections\.sh/,
  'sales refresh must not detach section generators outside the shared host lock',
);

assert.match(
  dailySource,
  /SHEIN_BI_PORTAL_PREWARM_SECTIONS=linksData[\s\S]*SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1[\s\S]*bash scripts\/prewarm_bi_portal_sections\.sh 8>&-/,
  'daily refresh must synchronously publish the inventory-critical linksData section',
);
assert.match(
  dailySource,
  /bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections homeRankings,afterSales,orders,homeProfit/,
  'daily refresh must queue priority accounting sections for the single host-locked worker',
);
assert.match(
  dailySource,
  /bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections actions,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings,profit/,
  'daily refresh must queue the remaining heavy sections instead of fanning them out',
);
assert.doesNotMatch(
  dailySource,
  /nohup\s+bash\s+scripts\/prewarm_bi_portal_sections\.sh/,
  'daily oneshot must not launch a child that systemd KillMode=control-group will terminate',
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
