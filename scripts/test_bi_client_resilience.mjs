#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'scripts', 'bi_app', 'client.js'), 'utf8');

assert.match(source, /window\.addEventListener\('hashchange',syncTabFromLocation\)/, 'hash navigation stays synchronized');
assert.match(source, /window\.addEventListener\('popstate',syncTabFromLocation\)/, 'browser back and forward are handled');
assert.match(source, /document\.addEventListener\('visibilitychange'/, 'long-open tabs refresh after becoming visible');
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

console.log('bi_client_resilience: refresh, version fallback, and history contracts passed');
