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

console.log('profit_refresh_pipeline_contract: cost ledger precedes profit refresh and stale-cache failures remain observable');
