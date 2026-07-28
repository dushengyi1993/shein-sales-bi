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
assert.match(source, /label:'已落定利润'.*storageNoteSar/, 'settled profit keeps storage fee as an inline supporting figure');
assert.match(source, /label:'风险调整后利润'.*`\u5f85决售后风险 /, 'risk-adjusted profit keeps pending risk as an inline supporting figure');
assert.doesNotMatch(source, /\{label:'(?:待决售后风险|已扣仓储费)',cells:/, 'profit summary must stay at three primary rows');
assert.match(source, /function profitRevenue\(r\)\{return firstNum\(r,\['known_net_revenue_sar','net_revenue_sar'/,
  'profit margin must divide covered profit by covered revenue, never by all revenue while costs are missing');
assert.match(source, /function profitRiskRevenue\(r\)\{return firstNum\(r,\['known_risk_adjusted_net_revenue_sar','known_net_revenue_sar'/,
  'risk-adjusted margin must use the same cost-covered population');
assert.match(source, /库存缺口估算 \$\{M\(p\.estimatedCostQty\)\} 件/,
  'negative-stock estimates must be visible without being presented as settled batch cost');
assert.match(source, /legacyEstimatedCostQty:hp\.reduce\(\(a,r\)=>a\+firstNum\(r,\['legacy_estimated_cost_quantity'\]\),0\)/,
  'profit aggregation includes date-aware historical cost estimates');
assert.match(source, /legacyEstimatedCostRevenue:hp\.reduce\(\(a,r\)=>a\+firstNum\(r,\['legacy_estimated_cost_revenue_sar'\]\),0\)/,
  'profit aggregation includes legacy estimated revenue');
assert.match(source, /legacyEstimatedCostLines:hp\.reduce\(\(a,r\)=>a\+firstNum\(r,\['legacy_estimated_cost_lines'\]\),0\)/,
  'profit aggregation includes legacy estimated lines');
assert.match(source, /历史成本估算 \$\{M\(p\.legacyEstimatedCostQty\)\} 件/,
  'legacy historical estimates are independently visible beside inventory-gap estimates');
assert.match(source, /在可售成本库存不足时，使用订单当时已有的在途批次或最近移动加权成本估算；不代表精确批次。/,
  'inventory-gap estimate tooltip explains its bounded cost basis without claiming an exact batch');
assert.match(source, /优先用订单日前已到仓批次；没有到仓记录时只用订单日前已实际发出的批次；不代表精确批次。/,
  'legacy estimate tooltip allows only cost evidence that existed by the order date');
assert.match(source, /完全没有成本依据，已显示为待成本，不会拿未来批次倒灌/,
  'fully missing costs stay separately labelled from both estimate types');
assert.match(server, /legacy_estimated_cost_revenue_sar: 0/,
  'homeProfit empty rows initialize legacy estimated revenue');
assert.match(server, /row\.legacy_estimated_cost_quantity \+= Number\(r\.legacy_estimated_cost_quantity \|\| 0\)/,
  'homeProfit aggregation retains legacy estimated quantities');
assert.match(server, /row\.legacy_estimated_cost_revenue_sar \+= Number\(r\.legacy_estimated_cost_revenue_sar \|\| 0\)/,
  'homeProfit aggregation retains legacy estimated revenue');
assert.match(server, /row\.legacy_estimated_cost_lines \+= Number\(r\.legacy_estimated_cost_lines \|\| 0\)/,
  'homeProfit aggregation retains legacy estimated lines');
assert.match(server, /'legacy_estimated_cost_revenue_sar'/,
  'homeProfit rounds and returns legacy estimated revenue');
assert.match(server, /'legacy_estimated_cost_quantity', 'legacy_estimated_cost_lines'/,
  'homeProfit rounds and returns legacy estimated counts');
assert.match(source, /'return-summary-matrix'\)\+/, 'returns and profit summary tables expose paired height-alignment classes');
assert.match(source, /function adaptivePriceScale\(values,maxBins=8\)/, 'price charts share one actual-range adaptive scale');
assert.match(source, /\(N\(v\)-minPrice\)\/scale\.span/, 'scatter y-axis starts at the actual minimum transaction price');
assert.match(source, /bestText=priceBandText\(best\)/, 'best-selling price band uses the same adaptive boundaries');
assert.doesNotMatch(source, /priceMax=niceCeil\(maxPrice\)/, 'scatter must not round its upper bound to coarse tens or hundreds');
assert.match(source, /function sourceState\(name,rows=\[\]\)\{const state=SS\[name\]\|\|\{\},st=state\.status\|\|'idle',expected=sectionExpectedAt\(\),actual=String\(state\.generatedAt\|\|''\);if\(expected&&actual&&actual!==expected\)return st==='error'\?'unavailable':'loading'/, 'a section from another core generation is never rendered as a current business number');
assert.match(source, /function clearSectionPayload\(n,generatedAt=''\)/, 'core transitions clear data owned by an older section generation');
assert.match(source, /clearSectionPayload\(name,generatedAt\);SS\[name\]=\{\.\.\.state,status:'idle'/, 'invalidating a section removes its incompatible payload before rendering');
assert.match(source, /if\(currentExpected&&responseGeneratedAt&&responseGeneratedAt!==currentExpected\)\{stale=true;versionWarning=.*clearSectionPayload\(n,currentExpected\).*return true\}/, 'an old in-flight response is quarantined instead of being merged after a new core arrives');
assert.match(source, /merge\(j,n\)/, 'accepted section payloads record their owning section and generation');
assert.match(source, /function unavailableValue\(\)\{return'<span class=\"metric-unavailable\"><b>—<\/b><small>数据不可用<\/small><\/span>'\}/, 'unavailable KPIs must show an em dash and explicit unavailable copy');
assert.match(source, /function sectionFailureNotice\(ns\).*data-load=.*role=\"alert\".*受影响 KPI 不会显示为 0/, 'failed sections have an actionable top-level alert with retry controls');
assert.match(source, /缓存写入 \$\{fmtStamp\(st\.cachedAt\|\|st\.generatedAt\)\}；页面最新/, 'cache fallback always exposes its cache timestamp and current-page timestamp');
assert.match(source, /j\.refreshFailed\?\('刷新失败'.*j\.refreshError/,
  'stale section responses must expose the concrete server refresh failure to the operator');
assert.match(source, /storageEstimated:hp\.reduce\(\(a,r\)=>a\+profitStorageEstimated\(r\),0\)/, 'profit tracks the exact provisional storage amount in the selected range');
assert.match(source, /含待结算预估/, 'provisional storage is labelled as an estimate while remaining deducted from profit');
assert.match(source, /纯历史范围不会再显示“今日待日结”/, 'historical queries never inherit a misleading current-day storage warning');
assert.doesNotMatch(source, /今日仓储费待日结\/未扣/, 'the old undifferentiated and misleading storage warning is removed');
assert.match(source, /chart-readable-details/, 'scatter chart exposes a readable detail path in addition to points');
assert.match(source, /class=\"chart-hit\" data-tip=.*tabindex=\"0\" role=\"img\" aria-label=/, 'trend data points are keyboard focusable and named');
assert.match(source, /if\(j\?\.pendingSection\)/, 'a pending first-generation section stays in loading state');
assert.match(server, /pendingSection: true/,
  'an async first-generation cache miss must be pending, never a successful empty business result');
assert.doesNotMatch(server, /data: \{\}, refreshScheduled, cacheHit: false/,
  'the server must not represent a missing section cache as valid empty data');
assert.match(server, /const key = `\$\{root\}\|\$\{section\}\|\$\{generatedAt \|\| ''\}`;/,
  'normal, warmup, and forced builders must share one single-flight key per section generation');
assert.doesNotMatch(server.match(/function scheduleBiSectionBackgroundGeneration[\s\S]*?\n\}/)?.[0] || '', /\$\{force \? '\|force' : ''\}/,
  'a forced refresh must not create a second concurrent producer key');

console.log('bi_client_resilience: refresh, version fallback, and history contracts passed');
