#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'scripts', 'serve_bi_portal.mjs'), 'utf8');

assert.match(source, /window\.addEventListener\('hashchange',syncTabFromLocation\)/, 'hash navigation stays synchronized');
assert.match(source, /window\.addEventListener\('popstate',syncTabFromLocation\)/, 'browser back and forward are handled');
assert.match(source, /document\.addEventListener\('visibilitychange'/, 'long-open tabs refresh after becoming visible');
assert.match(source, /setInterval\(\(\)=>\{revalidateCore\(\)\.catch\(\(\)=>\{\}\)\},CORE_VISIBLE_POLL_MS\)/, 'visible long-open tabs periodically revalidate core');
assert.match(source, /function scheduleSectionRecheck\(n\)/, 'stale sections schedule an automatic recheck');
assert.match(source, /load\(n,true,false,true\)/, 'section rechecks bypass browser state without forcing duplicate generation');
assert.match(source, /if\(needsRecheck\)scheduleSectionRecheck\(n\)/, 'stale or background-refresh responses are polled until current');
assert.match(source, /完成后页面会自动更新/, 'operator copy promises only the implemented automatic update');
assert.match(source, /await core\(\{silent:true,ensureAfter:false\}\)/, 'section version mismatches revalidate core first');
assert.match(source, /versionWarning=.*数据版本与 core 暂未同步/, 'persistent mismatches degrade to an explicit stale warning');
assert.doesNotMatch(source, /throw Error\(n\+' generatedAt 不匹配/, 'version mismatches must not hard-fail a usable cached page');
assert.match(source, /history\.pushState\(null,'',hash\)/, 'normal navigation creates browser history');
assert.match(source, /function inventoryMatchStatus\(r\)/, 'client keeps a backward-compatible inventory match-state reader');
assert.match(source, /match==='not_matched'/, 'client must not treat an unmatched ET record as zero stock');
assert.match(source, /match==='stale'/, 'client must surface stale ET snapshots distinctly');
assert.match(source, /仅在 ET 快照最新且已匹配、当前可售为 0、没有有效在途时成立/, 'client out-of-stock copy keeps the fresh-match invariant');
assert.match(source, /label:'已落定利润'.*`\u5176中仓储费 /, 'settled profit keeps storage fee as an inline supporting figure');
assert.match(source, /label:'风险调整后利润'.*`\u5f85决售后风险 /, 'risk-adjusted profit keeps pending risk as an inline supporting figure');
assert.doesNotMatch(source, /\{label:'(?:待决售后风险|已扣仓储费)',cells:/, 'profit summary must stay at three primary rows');
assert.match(source, /'return-summary-matrix'\)\+/, 'returns and profit summary tables expose paired height-alignment classes');
assert.match(source, /function adaptivePriceScale\(values,maxBins=8\)/, 'price charts share one actual-range adaptive scale');
assert.match(source, /\(N\(v\)-minPrice\)\/scale\.span/, 'scatter y-axis starts at the actual minimum transaction price');
assert.match(source, /bestText=priceBandText\(best\)/, 'best-selling price band uses the same adaptive boundaries');
assert.doesNotMatch(source, /priceMax=niceCeil\(maxPrice\)/, 'scatter must not round its upper bound to coarse tens or hundreds');
assert.match(source, /function sourceState\(name,rows=\[\]\)\{const st=SS\[name\]\?\.status\|\|'idle';if\(!rows\.length&&st==='error'\)return'unavailable'/, 'first-load section errors are represented as unavailable rather than zero-like data');
assert.match(source, /function unavailableValue\(\)\{return'<span class=\"metric-unavailable\"><b>—<\/b><small>数据不可用<\/small><\/span>'\}/, 'unavailable KPIs must show an em dash and explicit unavailable copy');
assert.match(source, /function sectionFailureNotice\(ns\).*data-load=.*role=\"alert\".*受影响 KPI 不会显示为 0/, 'failed sections have an actionable top-level alert with retry controls');
assert.match(source, /缓存写入 \$\{fmtStamp\(st\.cachedAt\|\|st\.generatedAt\)\}；页面最新/, 'cache fallback always exposes its cache timestamp and current-page timestamp');
assert.match(source, /j\.refreshFailed\?\('刷新失败'.*j\.refreshError/,
  'stale section responses must expose the concrete server refresh failure to the operator');
assert.match(source, /storageAwaitingSettlement:hp\.some\(profitStorageAwaitingSettlement\)/, 'live profit keeps an explicit storage-settlement state');
assert.match(source, /今日仓储费待日结\/未扣/, 'unsettled current-day storage is never presented as already deducted');
assert.match(source, /chart-readable-details/, 'scatter chart exposes a readable detail path in addition to points');
assert.match(source, /class=\"chart-hit\" data-tip=.*tabindex=\"0\" role=\"img\" aria-label=/, 'trend data points are keyboard focusable and named');
assert.match(source, /if\(j\?\.pendingSection\)/, 'a pending first-generation section stays in loading state');
assert.match(server, /pendingSection: true/,
  'an async first-generation cache miss must be pending, never a successful empty business result');
assert.doesNotMatch(server, /data: \{\}, refreshScheduled, cacheHit: false/,
  'the server must not represent a missing section cache as valid empty data');

console.log('bi_client_resilience: refresh, version fallback, and history contracts passed');
