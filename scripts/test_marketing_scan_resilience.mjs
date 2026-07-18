#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sheinSessionPostJson} from '../lib/shein_session_http.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marketingPath = path.join(root, 'scripts', 'marketing', 'scan_current_marketing_prices_for_bi.mjs');
const marketing = fs.readFileSync(marketingPath, 'utf8');
const stackReview = fs.readFileSync(path.join(root, 'scripts', 'marketing', 'export_marketing_stack_review.mjs'), 'utf8');
const links = fs.readFileSync(path.join(root, 'scripts', 'fetch_shein_links.mjs'), 'utf8');
const sessionHttp = fs.readFileSync(path.join(root, 'lib', 'shein_session_http.mjs'), 'utf8');

assert.match(marketing, /import \{connectCdp\} from '\.\.\/\.\.\/lib\/shein_browser\.mjs'/);
assert.match(marketing, /attempt <= args\.storeAttempts/);
assert.match(marketing, /isTransientMarketingScanError/);
assert.match(marketing, /transient scan failure on attempt/);
assert.match(marketing, /queryMarketingViaSessionHttp/);
assert.match(marketing, /assertCompleteMarketingPackets/);
assert.match(marketing, /--session-concurrency/);
assert.match(marketing, /Promise\.all\(batch\.map/);
assert.match(marketing, /T00:00:00/);
assert.doesNotMatch(marketing, /class Cdp/);

assert.match(stackReview, /await Promise\.all\(batch\.map\(scanStoreSafely\)\)/);
assert.match(stackReview, /session HTTP 并发扫描完成，未启动或关闭浏览器/);
assert.match(stackReview, /return \{activities: list, diagnostics\}/);
assert.doesNotMatch(stackReview, /fetchActivitiesHttp\.lastDiagnostics/);
const stackReviewBatchLoop = stackReview.slice(
  stackReview.indexOf('for (const [batchIndex, batch] of batches.entries())'),
  stackReview.indexOf('const limitRows = buildLimitDiscountRows'),
);
assert.doesNotMatch(stackReviewBatchLoop, /closeExistingStoreChrome/);

const help = spawnSync(process.execPath, [marketingPath, '--help'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:/);
assert.match(help.stdout, /exit without scanning/);
assert.match(help.stdout, /--session-http/);
assert.doesNotMatch(help.stdout, /^scan [A-Z]+/m);

const unknown = spawnSync(process.execPath, [marketingPath, '--definitely-unknown'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /Unknown option: --definitely-unknown/);

const unknownGroup = spawnSync(process.execPath, [marketingPath, '--group', 'NOT_A_GROUP'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(unknownGroup.status, 0);
assert.match(unknownGroup.stderr, /Unknown store group: NOT_A_GROUP/);

const invalidAttempts = spawnSync(process.execPath, [marketingPath, '--store-attempts', '6'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(invalidAttempts.status, 0);
assert.match(invalidAttempts.stderr, /--store-attempts must be an integer from 1 to 5/);

const invalidConcurrency = spawnSync(process.execPath, [marketingPath, '--session-concurrency', '7'], {cwd: root, encoding: 'utf8', timeout: 5000});
assert.notEqual(invalidConcurrency.status, 0);
assert.match(invalidConcurrency.stderr, /--session-concurrency must be an integer from 1 to 6/);

const dailyRefresh = fs.readFileSync(path.join(root, 'scripts', 'cloud_daily_refresh.sh'), 'utf8');
const liveGuard = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
assert.match(liveGuard, /--store-attempts "\$STORE_ATTEMPTS"/);
assert.match(liveGuard, /--session-http/);
assert.match(liveGuard, /browserless inspection via session HTTP/);
assert.doesNotMatch(liveGuard, /cleanup_shein_store_browsers/);
assert.doesNotMatch(liveGuard, /manage_browser_task_leases/);
assert.match(dailyRefresh, /skip duplicate all-store scan/);
assert.doesNotMatch(dailyRefresh, /scan_current_marketing_prices_for_bi\.mjs/);

let capturedRequest = null;
const response = await sheinSessionPostJson({cookie: 'secret-cookie', userAgent: 'test-agent'}, '/test', {hello: 'world'}, {
  fetchImpl: async (url, options) => {
    capturedRequest = {url, options};
    return {ok: true, status: 200, text: async () => JSON.stringify({code: '0', info: {ok: true}})};
  },
});
assert.equal(response.info.ok, true);
assert.equal(capturedRequest.options.headers.cookie, 'secret-cookie');
assert.equal(capturedRequest.options.headers['user-agent'], 'test-agent');
assert.match(sessionHttp, /No cookies in/);

assert.match(links, /import \{connectCdp\} from '\.\.\/lib\/shein_browser\.mjs'/);
assert.match(links, /cdp\.close\(\)/);
assert.doesNotMatch(links, /new Promise\(\(resolve, reject\) => pending\.set/);
assert.doesNotMatch(links, /process\.exit\(1\)/);

console.log('marketing_scan_resilience: browser fallback, browserless session HTTP, complete-evidence, and retry contracts passed');
