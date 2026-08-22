#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const [source, generatorSource, profitRefreshSource, inventoryLedgerSource] = await Promise.all([
  fs.readFile(new URL('./serve_bi_portal.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./generate_bi_portal.mjs', import.meta.url), 'utf8'),
  fs.readFile(new URL('./refresh_profit_marts.sh', import.meta.url), 'utf8'),
  fs.readFile(new URL('./rebuild_inventory_cost_ledger.mjs', import.meta.url), 'utf8'),
]);

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
assert.match(source, /const ledgerRun = await refreshInventoryCostLedger\(args, options\);[\s\S]*const profitRun = await refreshProfitMarts\(args, options\);/,
  'a stale ledger must be rebuilt and verified before profit marts are refreshed under the owned cancellation context');
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
assert.match(source, /const BI_DB_APPLICATION_NAME_RE = \/\^\[A-Za-z0-9\][\s\S]*function createBiDbApplicationName[\s\S]*crypto\.randomBytes\(12\)/,
  'each owned section producer must receive a unique strictly validated PostgreSQL application_name');
assert.match(source, /const dbApplicationName = options\.dbApplicationName[\s\S]*: signal[\s\S]*\? createBiDbApplicationName\(section\)/,
  'a non-null owned cancellation signal must create the database application_name without relying on a route flag');
assert.match(source, /const BI_DB_CANCEL_REMAINING_MARKER = 'SHEIN_BI_DB_CANCEL_REMAINING='/,
  'backend reconciliation must use one stable machine-readable remaining-count marker');
assert.match(source, /pg_cancel_backend\(pid\)[\s\S]*application_name = :'target_application_name'[\s\S]*pg_sleep\([\s\S]*pg_terminate_backend\(pid, 1000\)[\s\S]*BI_DB_CANCEL_REMAINING_MARKER/,
  'backend cancellation must target the exact psql-quoted application_name, wait briefly, terminate survivors, and emit a final count marker');
assert.match(source, /cancelApplicationName = createBiDbApplicationName\('cancel'\)[\s\S]*\{applicationName: cancelApplicationName\}/,
  'the independent cancellation connection must use a distinct application_name');
assert.match(source, /function evaluateBiDbCancellationRun[\s\S]*run\.ok !== true[\s\S]*matches\.length !== 1[\s\S]*remainingBackendCount !== 0[\s\S]*remainingBackendCount: 0/,
  'cancel helper must succeed only for an ok command with exactly one zero remaining marker');
assert.match(source, /if \(run\.terminationRequested && applicationName\)[\s\S]*await cancellationPromise[\s\S]*startCancellation\('final'/,
  'terminated DB runs must await immediate cancellation and then unconditionally run final reconciliation');
assert.match(source, /startCancellation\('immediate', cause\)[\s\S]*startCancellation\('final', cancellationCause/,
  'DB-bound termination must have exactly the immediate and final cancellation phases');
assert.match(source, /const BI_DB_CANCEL_TIMEOUT_MS = 4_000[\s\S]*killGraceMs: 250[\s\S]*settleGraceMs: 250/,
  'each cancellation phase including child cleanup must remain inside five seconds');
assert.match(source, /event: 'bi-db-backend-cancel-failed'/,
  'backend cancellation failure must remain observable even when AbortSignal handling replaces the child error');
assert.match(source, /async function refreshProfitMarts[\s\S]*runBiDbChildProcess[\s\S]*SHEIN_BI_DB_APPLICATION_NAME: dbApplicationName/,
  'profit mart refresh must receive the owned application_name and DB cancellation wrapper');
assert.match(source, /async function refreshInventoryCostLedger[\s\S]*runBiDbChildProcess[\s\S]*SHEIN_BI_DB_APPLICATION_NAME: dbApplicationName/,
  'inventory ledger refresh must receive the owned application_name and DB cancellation wrapper');
assert.match(source, /async function readProfitMartCacheFreshness[\s\S]*psqlSpawnCommand\(args, ' -q -t -A', \{applicationName: dbApplicationName\}\)[\s\S]*runBiDbChildProcess/,
  'profit freshness psql must use the exact owned application_name and DB cancellation wrapper');
assert.match(source, /async function generateBiSection[\s\S]*runBiDbChildProcess\(args, process\.execPath[\s\S]*SHEIN_BI_DB_APPLICATION_NAME: dbApplicationName/,
  'the final section generator must inherit the same owned application_name');
assert.match(profitRefreshSource, /SHEIN_BI_DB_APPLICATION_NAME[\s\S]*DB_APPLICATION_ENV=\(-e "PGAPPNAME=\$APPLICATION_NAME"\)[\s\S]*exec -i "\$\{DB_APPLICATION_ENV\[@\]\}"[\s\S]*psql/,
  'profit mart docker exec must map the validated token to PGAPPNAME');
assert.match(inventoryLedgerSource, /SHEIN_BI_DB_APPLICATION_NAME[\s\S]*dockerApplicationEnv[\s\S]*PGAPPNAME=\$\{args\.applicationName\}[\s\S]*'psql'/,
  'every inventory-ledger docker exec must map the validated token to PGAPPNAME');
assert.match(generatorSource, /SHEIN_BI_DB_APPLICATION_NAME[\s\S]*function psqlSpawnCommand[\s\S]*PGAPPNAME=\$\{BI_DB_APPLICATION_NAME\}[\s\S]*docker exec -i\$\{applicationEnv\}/,
  'every final-generator psql docker exec must map the validated token to PGAPPNAME');

console.log('profit_refresh_pipeline_contract: cost ledger order, exact PostgreSQL cancellation, and PGAPPNAME propagation are enforced');
