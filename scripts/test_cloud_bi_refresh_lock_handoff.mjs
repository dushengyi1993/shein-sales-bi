#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./cloud_bi_refresh.sh', import.meta.url), 'utf8');
const dailySource = await fs.readFile(new URL('./cloud_daily_refresh.sh', import.meta.url), 'utf8');
const morningSource = await fs.readFile(new URL('./cloud_morning_chain.sh', import.meta.url), 'utf8');
const prewarmSource = await fs.readFile(new URL('./prewarm_bi_portal_sections.sh', import.meta.url), 'utf8');
const queueWorkerSource = await fs.readFile(new URL('./cloud_portal_section_queue_worker.sh', import.meta.url), 'utf8');

assert.match(
  source,
  /--sections homeRankings,afterSales,orders[\s\S]*--priority 4[\s\S]*--sections profit[\s\S]*--priority 5[\s\S]*--sections homeProfit,homeTrafficDaily,priceScatter[\s\S]*--priority 10/,
  'sales refresh must enqueue priority Portal sections instead of detaching a generator',
);
assert.ok(
  source.indexOf('--sections profit') < source.indexOf('--sections homeProfit,homeTrafficDaily,priceScatter'),
  'sales refresh must give profit an earlier, stronger dependency lane than homeProfit',
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
  /SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM:-\s*sync/,
  'the synchronous homepage-critical prewarm must remain the default for standalone daily runs',
);
assert.match(
  dailySource,
  /SHEIN_BI_DAILY_CRITICAL_PORTAL_SECTIONS:-\s*homeRankings,homeTrafficDaily,priceScatter,afterSales,orders,profit,homeProfit[\s\S]*CRITICAL_PORTAL_PREWARM_MODE" == "sync"[\s\S]*SHEIN_BI_PORTAL_PREWARM_ASYNC=0[\s\S]*SHEIN_BI_PORTAL_PREWARM_HOST_LOCKED=1[\s\S]*bash scripts\/prewarm_bi_portal_sections\.sh 8>&-/,
  'sync mode must synchronously build profit before homeProfit and finish all homepage-critical sections before the standalone run completes',
);
assert.match(
  dailySource,
  /enqueue homepage-critical sections for the bounded queue worker[\s\S]*bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections "\$CRITICAL_PORTAL_SECTIONS"[\s\S]*--priority "\$\{SHEIN_BI_DAILY_CRITICAL_PORTAL_QUEUE_PRIORITY:-10\}"/,
  'queue mode must hand every homepage-critical section to the bounded section queue instead of a synchronous prewarm',
);
assert.match(
  dailySource,
  /SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue cannot be combined with SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1[\s\S]*exit 64/,
  'queue mode combined with REQUIRE_CRITICAL_PORTAL_SECTIONS=1 must fail closed instead of silently downgrading the requirement',
);
assert.match(
  morningSource,
  /SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=0[\s\S]*SHEIN_BI_DAILY_CRITICAL_PORTAL_PREWARM=queue/,
  'the morning coordinator must delegate homepage-critical sections to the bounded queue instead of forcing synchronous critical completion',
);
assert.doesNotMatch(
  morningSource,
  /SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS=1/,
  'the morning coordinator must never force a synchronous homepage-critical gate that can exhaust the reserved inventory window',
);
assert.match(
  dailySource,
  /CRITICAL_PORTAL_STATUS[\s\S]*SHEIN_BI_DAILY_REQUIRE_CRITICAL_PORTAL_SECTIONS[\s\S]*exit 75/,
  'critical section failure must be retryable instead of being marked as a completed daily publish',
);
assert.match(
  dailySource,
  /if ! flock -w "\$PORTAL_REFRESH_LOCK_WAIT_SEC" 8; then\s*CRITICAL_PORTAL_STATUS=75/,
  'a busy Portal publish lock must keep the critical daily run incomplete',
);
assert.match(
  prewarmSource,
  /FAILED_SECTIONS=\(\)[\s\S]*FAILED_SECTIONS\+=\("\$SECTION:\$STATUS"\)[\s\S]*exit 1/,
  'prewarm must return failure when any requested section times out or fails',
);
assert.match(
  dailySource,
  /bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*--sections actions,productState,productSalesDaily,productTrafficDaily,comments,rtvData,waybills,rankings\s*\\[\s\S]*--priority 50/,
  'daily refresh must queue the remaining heavy sections instead of fanning them out',
);
const dailyEnqueues = dailySource.match(/bash scripts\/enqueue_bi_portal_sections\.sh[\s\S]*?--reason "daily-refresh-\$DATE"/g) || [];
assert.ok(
  dailyEnqueues.length >= 1,
  'daily refresh must enqueue portal sections with the daily-refresh reason',
);
assert.doesNotMatch(
  dailyEnqueues[dailyEnqueues.length - 1] || '',
  /--sections[^\n]*\bprofit\b/,
  'the final non-critical enqueue must never re-queue profit after the homepage-critical batch (sync prewarm or queue lane)',
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

assert.match(
  queueWorkerSource,
  /X-BI-Section-\(Stale\|Refresh-Failed\):\[\[:space:\]\]\*true/,
  'the section queue worker must treat a stale or failed-refresh 2xx as a failed section',
);
assert.match(
  queueWorkerSource,
  /queue_command fail --section "\$SECTION" --lease-id "\$LEASE_ID"[\s\S]*stale\/failed refresh header/,
  'a stale/failed 2xx must fail the lease instead of completing the queue entry',
);
assert.match(
  queueWorkerSource,
  /CLAIMED_SECTIONS=\(\)[\s\S]*--exclude-sections[\s\S]*CLAIMED_SECTIONS\+=\("\$SECTION"\)/,
  'one queue service run must spend its bounded slots on distinct sections',
);
assert.match(
  queueWorkerSource,
  /HOME_RANKINGS_MIN_RUNTIME_SEC=.*540[\s\S]*EXCLUDED_SECTIONS\+=\(homeRankings\)[\s\S]*defer heavy section=homeRankings/,
  'the measured multi-minute homeRankings rebuild must not enter a short ET queue window',
);
assert.match(
  queueWorkerSource,
  /if \[\[ "\$\{#FAILED_SECTIONS\[@\]\}" -gt 0 \]\]; then[\s\S]*failed sections=[\s\S]*exit 1/,
  'a failed lease must keep systemd failed until a later successful lease completes the requested revision',
);
assert.match(
  prewarmSource,
  /X-BI-Section-\(Stale\|Refresh-Failed\):\[\[:space:\]\]\*true[\s\S]*FAILED_SECTIONS\+\=/,
  'prewarm must record a stale or failed-refresh 2xx as a section failure',
);

console.log('cloud_bi_refresh_lock_handoff: lock handoff and marketing snapshot health checks passed');
