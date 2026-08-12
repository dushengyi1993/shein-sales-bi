#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8');

assert.match(source, /'costRunSourceCutoffAt'/,
  'profit freshness query must load the latest completed ledger source cutoff');
assert.match(source, /'costAssignmentPostCutoverMissingRows'/,
  'profit freshness query must measure post-cutover cost assignment coverage');
assert.match(source, /oi\.created_date >= c\.cutover_date[\s\S]*coalesce\(oi\.quantity,0\) > 0[\s\S]*coalesce\(oi\.sales_sar,0\) > 0/,
  'cost assignment coverage must use the same positive-sale population as the ledger rebuild');
assert.match(source, /'orderFactUpdatedAt', \(SELECT max\(updated_at\) FROM fact\.order_item\)/,
  'freshness must include zeroed cancellation rows so their prior ledger assignment is removed');
assert.match(source, /'accountingInputUpdatedAt', greatest\([\s\S]*fact\.after_sales_item[\s\S]*fact\.openapi_return_item/,
  'return and after-sales changes must invalidate profit even when order rows do not change');
assert.match(source, /const ledgerRun = await refreshInventoryCostLedger\(args\);[\s\S]*const profitRun = await refreshProfitMarts\(args\);/,
  'a stale ledger must be rebuilt and verified before profit marts are refreshed');
assert.match(source, /inventory cost ledger remains incomplete after refresh/,
  'a failed ledger coverage recheck must preserve the prior complete section cache rather than publish a profit-only result');
assert.match(source, /biSectionRefreshFailures/,
  'section refresh failures must be retained as visible stale-cache metadata');
assert.match(source, /INVENTORY_COST_SNAPSHOT_RETRY_RE[\s\S]*INVENTORY_COST_REFRESH_MAX_ATTEMPTS/,
  'snapshot conflicts must have a small bounded retry policy');
assert.match(source, /for \(let attempt = 1; attempt <= INVENTORY_COST_REFRESH_MAX_ATTEMPTS; attempt \+= 1\)[\s\S]*INVENTORY_COST_SNAPSHOT_RETRY_RE\.test\(detail\)/,
  'only the expected concurrent-source snapshot conflict may retry');
assert.match(source, /existingCurrent[\s\S]*refreshRetryPending: true[\s\S]*clearBiSectionRefreshFailure/,
  'a failed refresh must not poison an already published current-generation cache');
assert.doesNotMatch(source, /DEFAULT_BI_PORTAL_CORE_WARMUP_SECTIONS = \[[^\]]*waybills/,
  'non-critical waybills must not keep the core warmup watcher in a one-minute error loop');

console.log('profit_refresh_pipeline_contract: cost ledger precedes profit refresh and stale-cache failures remain observable');
