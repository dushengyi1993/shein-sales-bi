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
assert.match(source, /if\(n==='liveSalesToday'\)LAST_LIVE_REFRESH_MS=Date\.now\(\)/,
  'every accepted live-order projection records the last successful refresh time');
assert.match(source, /async function revalidateCore\(\).*liveDue=now-LAST_LIVE_REFRESH_MS>=CORE_VISIBLE_POLL_MS.*if\(liveDue&&SS\.liveSalesToday\?\.status!=='error'\)await load\('liveSalesToday',true,true\)/,
  'the five-minute visible-tab fallback refreshes live orders without bypassing terminal section errors');
assert.match(source, /\[D\.liveSalesToday\?\.date,D\.dates\?\.salesDate,D\.dates\?\.businessDate,D\.dates\?\.linkDate\]/,
  'the authoritative live-sales business date participates in the page date anchor even before the first order arrives');
assert.match(source, /const key=\[genAt\(\),ISO\(D\.liveSalesToday\?\.date\),/,
  'the date-anchor cache is invalidated when the live-sales business date rolls over');
assert.match(source, /function validDateOnly\(v\).*\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$.*isoDate\(d\)===text/,
  'live-sales dates use strict calendar validation instead of accepting any ten-character prefix');
assert.match(source, /source==='liveSalesToday'&&\(!validDateOnly\(live\?\.date\)\|\|!Array\.isArray\(live\?\.items\)\).*已拒绝覆盖当前经营数据/,
  'an incomplete live-sales payload fails closed before it can replace usable business data');
assert.match(source, /items=D\.liveSalesToday\?\.items;if\(!date\|\|!Array\.isArray\(items\)\|\|!D\.rankings\)return/,
  'a missing live-sales items field cannot be normalized into an explicit zero-order overlay');
assert.match(source, /function dates\(force=false\)\{const preset=S\.rangePreset\|\|'today';if\(S\.start&&S\.end&&preset==='custom'\)return;const next=computePresetRange\(preset,dataAnchorDate\(\)\);if\(!force&&S\.start===next\.start&&S\.end===next\.end\)return;applyPreset\(preset\)\}/,
  'non-custom date presets follow a newer data anchor while an operator-selected custom range stays fixed');

const sourceLines = source.split(/\r?\n/);
const functionLine = name => sourceLines.find(line => line.startsWith(`function ${name}(`)) || '';
const callableLine = name => functionLine(name) || sourceLines.find(line => line.startsWith(`async function ${name}(`)) || '';

const manualRefreshTokenSource = functionLine('manualSectionRefreshToken');
const sectionUrlSource = functionLine('surl');
assert.ok(manualRefreshTokenSource, 'manual force refreshes must have an explicit intent-token generator');
assert.match(sectionUrlSource,
  /LIVE_REFRESH_RUNNING&&LIVE_REFRESH_TOKEN\?LIVE_REFRESH_TOKEN:manualSectionRefreshToken\(n\)/,
  'one live event must reuse its event token while every non-live force intent gets a fresh token');
assert.match(sectionUrlSource, /params\.set\('refreshToken',refreshToken\)/,
  'every HTTP force refresh must send its selected refresh token');
const manualSectionRefreshToken = Function(`let MANUAL_REFRESH_SEQUENCE=0;${manualRefreshTokenSource};return manualSectionRefreshToken;`)();
const firstManualRefreshToken = manualSectionRefreshToken('orders');
const secondManualRefreshToken = manualSectionRefreshToken('orders');
assert.match(firstManualRefreshToken, /^portal-manual:orders:/);
assert.notEqual(secondManualRefreshToken, firstManualRefreshToken,
  'two explicit operator retries must be separate intents instead of colliding with one completed tombstone');
assert.ok(firstManualRefreshToken.length <= 160 && secondManualRefreshToken.length <= 160,
  'manual force tokens must stay within the server-side token bound');

const makeCoreRecoveryRuntime = () => {
  const callbacks = [];
  const cleared = [];
  let coreCalls = 0;
  const runtime = Function('setTimeout','clearTimeout','document','core',`
    let S={core:'error'},CORE_ERROR_RECOVERY_TIMER=null,CORE_ERROR_RECOVERY_ATTEMPT=0;
    const CORE_ERROR_RECOVERY_BASE_MS=60000;
    const CORE_ERROR_RECOVERY_MAX_MS=240000;
    const CORE_ERROR_RECOVERY_MAX_ATTEMPTS=3;
    ${functionLine('clearCoreErrorRecoveryTimer')}
    ${functionLine('resetCoreErrorRecovery')}
    ${functionLine('scheduleCoreErrorRecovery')}
    return {scheduleCoreErrorRecovery,resetCoreErrorRecovery,state:()=>({attempt:CORE_ERROR_RECOVERY_ATTEMPT,timer:CORE_ERROR_RECOVERY_TIMER})};
  `)((callback,delay)=>{const id=callbacks.length+1;callbacks.push({callback,delay,id});return id},id=>cleared.push(id),{visibilityState:'visible'},()=>{coreCalls+=1;return Promise.resolve(false)});
  return {runtime,callbacks,cleared,coreCalls:()=>coreCalls};
};
{
  const harness = makeCoreRecoveryRuntime();
  for(let index=0;index<3;index+=1){
    harness.runtime.scheduleCoreErrorRecovery();
    assert.equal(harness.callbacks.length,index+1,`core recovery attempt ${index+1} must be scheduled once`);
    harness.callbacks[index].callback();
  }
  assert.deepEqual(harness.callbacks.map(item=>item.delay),[60000,120000,240000],
    'core recovery uses bounded low-frequency exponential delays starting at 60s');
  assert.equal(harness.coreCalls(),3);
  assert.equal(harness.runtime.state().attempt,3);
  harness.runtime.scheduleCoreErrorRecovery();
  assert.equal(harness.callbacks.length,3,'core recovery must stop permanently after the third automatic attempt');
}
{
  const harness = makeCoreRecoveryRuntime();
  harness.runtime.scheduleCoreErrorRecovery();
  assert.notEqual(harness.runtime.state().timer,null);
  harness.runtime.resetCoreErrorRecovery();
  assert.deepEqual(harness.runtime.state(),{attempt:0,timer:null},'manual retry or success resets the core recovery state');
  assert.deepEqual(harness.cleared,[1],'reset clears the old core recovery timer before a manual request');
  harness.runtime.scheduleCoreErrorRecovery();
  assert.equal(harness.callbacks[1].delay,60000,'a reset restarts recovery from the first 60s delay');
}

const httpErrorRuntimeParts = [
  functionLine('portalErrorText'), functionLine('portalErrorCode'), functionLine('portalRequestId'),
  functionLine('portalRetryAfter'), functionLine('portalPublicDetail'), functionLine('portalHttpAction'),
  callableLine('portalHttpError'),
];
assert.ok(httpErrorRuntimeParts.every(Boolean), 'HTTP error helpers are extractable for deterministic behavior checks');
const portalHttpError = Function(`${httpErrorRuntimeParts.join('\n')}\nreturn portalHttpError;`)();
const mockResponse = (status, payload, headers={}) => ({
  status,
  headers: {get: name => headers[String(name).toLowerCase()] || ''},
  json: async () => payload,
});
{
  const error = await portalHttpError(mockResponse(400, {
    code: 'INVALID_RANGE',
    message: '开始日期不能晚于结束日期',
    requestId: 'req-400-safe',
    debug: {password: 'must-not-render'},
  }), 'Core');
  assert.match(error.message, /Core HTTP 400/);
  assert.match(error.message, /请求参数不合法/);
  assert.match(error.message, /开始日期不能晚于结束日期/);
  assert.match(error.message, /错误码 INVALID_RANGE/);
  assert.match(error.message, /请求 ID req-400-safe/);
  assert.doesNotMatch(error.message, /must-not-render|password/i);
}
{
  const error = await portalHttpError(mockResponse(429, {
    error: {code: 'RATE_LIMITED', message: '请求过于频繁'},
    correlationId: 'corr-429-safe',
  }, {'retry-after': '120'}), '订单');
  assert.match(error.message, /订单 HTTP 429/);
  assert.match(error.message, /错误码 RATE_LIMITED/);
  assert.match(error.message, /请求 ID corr-429-safe/);
  assert.match(error.message, /Retry-After 120 秒/);
}
{
  const error = await portalHttpError(mockResponse(502, {
    code: 'UPSTREAM_FAILURE',
    message: 'connect ECONNREFUSED 10.0.0.5 password=super-secret',
    stack: 'at internalCall /opt/private/server.js:12',
  }, {'x-request-id': 'req-502-safe'}), 'Core');
  assert.match(error.message, /Core HTTP 502/);
  assert.match(error.message, /云端数据服务暂不可用/);
  assert.match(error.message, /错误码 UPSTREAM_FAILURE/);
  assert.match(error.message, /请求 ID req-502-safe/);
  assert.doesNotMatch(error.message, /10\.0\.0\.5|super-secret|ECONNREFUSED|\/opt\/|stack|internalCall/i,
    'sensitive upstream details must never reach the operator-facing error');
}

{
  const recoverySource = functionLine('scheduleSectionErrorRecovery');
  const state = {orders:{status:'error',error:'HTTP 502',recoveryAttempt:3,recheckAttempt:30}};
  const timers = {};
  const callbacks = [];
  let loads = 0;
  const schedule = Function('SS','SECTION_RECHECK_TIMERS','setTimeout','document','load','render',`
    const SECTION_ERROR_RECOVERY_MS=60000;
    const SECTION_ERROR_RECOVERY_MAX_ATTEMPTS=3;
    ${recoverySource}
    return scheduleSectionErrorRecovery;
  `)(state,timers,callback=>{callbacks.push(callback);return callbacks.length},{visibilityState:'visible'},()=>{loads+=1;return Promise.resolve(false)},()=>{});
  schedule('orders');
  assert.equal(callbacks.length,0,'an exhausted section error must not retry forever');
  state.orders.recoveryAttempt=2;
  schedule('orders');
  assert.equal(callbacks.length,1,'one final bounded recovery attempt may be scheduled');
  callbacks[0]();
  assert.equal(loads,1);
  assert.equal(state.orders.recoveryAttempt,3);
  assert.equal(state.orders.recheckAttempt,30, 'recovery keeps the exhausted recheck count instead of reopening an automatic loop');
}
{
  const recheckSource = functionLine('scheduleSectionRecheck');
  const state = {homeRankings:{status:'ok',refreshing:true,stale:true,recheckAttempt:30,recoveryAttempt:3}};
  const timers = {};
  let recoveryCalls = 0;
  const schedule = Function('SS','SECTION_RECHECK_TIMERS','setTimeout','clearTimeout','render','scheduleSectionErrorRecovery',`
    const SECTION_RECHECK_BASE_MS=5000;
    const SECTION_RECHECK_MAX_MS=30000;
    const SECTION_RECHECK_MAX_ATTEMPTS=30;
    ${recheckSource}
    return scheduleSectionRecheck;
  `)(state,timers,callback=>{timers.next=callback;return 'recheck'},()=>{},()=>{},()=>{recoveryCalls+=1});
  schedule('homeRankings');
  assert.equal(timers.next, undefined, 'the thirtieth recheck does not schedule a thirty-first request');
  assert.equal(state.homeRankings.refreshing, false);
  assert.equal(state.homeRankings.recheckAttempt,30);
  assert.equal(recoveryCalls,1, 'exhausted rechecks enter the bounded recovery circuit');
}
const collectDatesStart = source.indexOf('function collectDates()');
const collectDatesEnd = source.indexOf('\nfunction dataAnchorDate()', collectDatesStart);
const collectDatesSource = source.slice(collectDatesStart, collectDatesEnd);
const dateRuntimeParts = [
  functionLine('parseDateOnly'), functionLine('isoDate'), functionLine('validDateOnly'), functionLine('addDateDays'),
  functionLine('monthStart'), functionLine('addMonths'), functionLine('monthEnd'),
  collectDatesSource, functionLine('dataAnchorDate'), functionLine('computePresetRange'),
  functionLine('calendarMonthStart'), functionLine('addCalendarMonths'),
  functionLine('applyPreset'), functionLine('dates'),
];
assert.ok(dateRuntimeParts.every(Boolean), 'date rollover functions are extractable for integrated behavior checks');
const dateRuntimeSource = dateRuntimeParts.join('\n');
const makeDateRuntime = (data, state, DateCtor=Date) => Function('D', 'S', 'Date', `
  const A=v=>Array.isArray(v)?v:[];
  const ISO=v=>String(v||'').slice(0,10);
  const pad2=v=>String(v).padStart(2,'0');
  function dt(r){return ISO(r?.date||r?.stat_date||r?.created_date||r?.snapshot_date)}
  function genAt(){return String(D.generatedAt||'core-generation')}
  let DATA_ANCHOR_CACHE={key:'',value:''};
  ${dateRuntimeSource}
  return {dataAnchorDate,dates};
`)(data, state, DateCtor);
{
  const data = {dates:{salesDate:'2026-08-10'}, liveSalesToday:{date:'2026-08-11', items:[]}};
  const state = {rangePreset:'today', start:'2026-08-10', end:'2026-08-10'};
  makeDateRuntime(data, state).dates(false);
  assert.deepEqual({start:state.start,end:state.end}, {start:'2026-08-11',end:'2026-08-11'},
    'today preset advances across midnight from the real live-sales anchor, including an explicit zero-order day');
}
{
  const state = {rangePreset:'custom', start:'2026-08-10', end:'2026-08-10'};
  const runtime = makeDateRuntime({liveSalesToday:{date:'2026-08-11',items:[]}}, state);
  runtime.dates(false);
  runtime.dates(true);
  assert.deepEqual({start:state.start,end:state.end}, {start:'2026-08-10',end:'2026-08-10'},
    'custom date range survives both background refresh and forced core retry');
}
{
  const data = {liveSalesToday:{date:'2026-08-10',items:[]}};
  const runtime = makeDateRuntime(data, {rangePreset:'today',start:'',end:''});
  assert.equal(runtime.dataAnchorDate(), '2026-08-10');
  data.liveSalesToday.date='2026-08-11';
  assert.equal(runtime.dataAnchorDate(), '2026-08-11', 'date-anchor cache notices a live business-date rollover');
}
{
  class LocalMidnightDate {
    getTime(){return 1}
    getFullYear(){return 2026}
    getMonth(){return 7}
    getDate(){return 11}
    toISOString(){return '2026-08-10T16:15:00.000Z'}
  }
  const runtime = makeDateRuntime({}, {rangePreset:'today',start:'',end:''}, LocalMidnightDate);
  assert.equal(runtime.dataAnchorDate(), '2026-08-11', 'fallback uses the browser-local date instead of the previous UTC date near midnight');
}
{
  const mergeStart=source.indexOf("function merge(x,source='')");
  const mergeEnd=source.indexOf('\nfunction replaceRankingDate(',mergeStart);
  const mergeSource=source.slice(mergeStart,mergeEnd);
  const data={liveSalesToday:{date:'2026-08-10',items:[{order_no:'kept'}]}};
  const mergeRuntime=Function('D',`
    const pad2=v=>String(v).padStart(2,'0');
    const ISO=v=>String(v||'').slice(0,10);
    ${functionLine('parseDateOnly')}
    ${functionLine('isoDate')}
    ${functionLine('validDateOnly')}
    let DG={},DATA_ANCHOR_CACHE={key:'',value:''},PRICE_META=new WeakMap();
    ${mergeSource}
    return {merge,getGeneration:key=>DG[key]?.generatedAt||''};
  `)(data);
  const merge=mergeRuntime.merge;
  for(const badDate of ['not-a-date','2026-02-31']){
    assert.throws(()=>merge({data:{liveSalesToday:{date:badDate,items:[]}}},'liveSalesToday'),/已拒绝覆盖当前经营数据/);
    assert.equal(data.liveSalesToday.date,'2026-08-10','invalid live date cannot replace the previous complete payload');
    assert.equal(data.liveSalesToday.items[0].order_no,'kept','invalid live date cannot erase previous order facts');
  }
  merge({generatedAt:'2026-08-24T07:59:49+08:00',data:{rankings:{dailyStores:[{sales_sar:12}]}}},'homeRankings');
  assert.equal(mergeRuntime.getGeneration('rankings'),'2026-08-24T07:59:49+08:00',
    'degraded cross-generation data keeps the source generation as its DG ownership');
}
{
  const overlayStart=source.indexOf('function applyLiveOrderRankingOverlay()');
  const overlayEnd=source.indexOf('\nfunction liveOrderKey(',overlayStart);
  const overlaySource=source.slice(overlayStart,overlayEnd);
  const runOverlay=data=>Function('D','ISO',`
    const A=v=>Array.isArray(v)?v:[];
    const N=v=>{const n=Number(v??0);return Number.isFinite(n)?n:0};
    const sk=r=>String(r?.store_key||r?.storeKey||'').trim().toUpperCase();
    const smeta=new Map();
    let DATA_ANCHOR_CACHE={key:'',value:''};
    ${functionLine('replaceRankingDate')}
    ${overlaySource}
    applyLiveOrderRankingOverlay();
  `)(data,v=>String(v||'').slice(0,10));
  const data={liveSalesToday:{date:'2026-08-11'},rankings:{dailyStores:[{date:'2026-08-11',sales_sar:123}]}};
  runOverlay(data);
  assert.equal(data.rankings.dailyStores[0].sales_sar,123,'missing items preserves the previous complete ranking instead of fabricating zero');
  data.liveSalesToday.items=[];
  runOverlay(data);
  assert.deepEqual(data.rankings.dailyStores,[],'an explicit empty items array is accepted as a verified zero-order day');
}
{
  const sourceStateSource = functionLine('sourceState');
  const sourceState = Function('D','SS',`
    function sectionExpectedAt(){return D.__sections?.generatedAt||D.generatedAt||''}
    ${sourceStateSource}
    return sourceState;
  `)({__sections:{generatedAt:'G2'}},{homeRankings:{status:'ok',generatedAt:'G1',sourceGeneratedAt:'G1',hasData:true,degraded:true,coreGeneratedAt:'G2'}});
  assert.equal(sourceState('homeRankings',[{sales_sar:12}]),'',
    'the client renders an old source generation only when degraded data and current core metadata are explicit');
  const quarantined = Function('D','SS',`
    function sectionExpectedAt(){return D.__sections?.generatedAt||D.generatedAt||''}
    ${sourceStateSource}
    return sourceState;
  `)({__sections:{generatedAt:'G2'}},{homeRankings:{status:'ok',generatedAt:'G1',hasData:true,degraded:false,coreGeneratedAt:'G2'}});
  assert.equal(quarantined('homeRankings',[{sales_sar:12}]),'loading',
    'an old non-degraded source remains unavailable to current KPI rendering');
}
{
  const invalidateSource = functionLine('invalidateSectionsForCore');
  const sourceStateSource = functionLine('sourceState');
  const state = {homeRankings:{status:'ok',generatedAt:'G1',sourceGeneratedAt:'G1',hasData:true,degraded:true,coreGeneratedAt:'G2',stale:true,refreshing:false,accountingPending:true}};
  let recheckClears = 0;
  let payloadClears = 0;
  const invalidate = Function('SS','clearSectionRecheck','clearSectionPayload',`${invalidateSource}
    return invalidateSectionsForCore;`)(state,()=>{recheckClears+=1},()=>{payloadClears+=1});
  invalidate('G3');
  assert.equal(state.homeRankings.coreGeneratedAt,'G2','core invalidation must not rebind old source ownership to G3');
  assert.equal(state.homeRankings.coreRevalidationTargetAt,'G3');
  assert.equal(state.homeRankings.coreRevalidationRequired,true);
  assert.equal(state.homeRankings.status,'loading');
  assert.equal(recheckClears,1);
  assert.equal(payloadClears,0,'core transition keeps the old payload only behind explicit server revalidation');
  const sourceState = Function('D','SS',`
    function sectionExpectedAt(){return D.__sections?.generatedAt||D.generatedAt||''}
    ${sourceStateSource}
    return sourceState;
  `)({__sections:{generatedAt:'G3'}},state);
  assert.equal(sourceState('homeRankings',[{sales_sar:12}]),'loading','G1 data is hidden while G3 revalidation is outstanding');
  const recheckSource = functionLine('scheduleSectionRecheck');
  const recoverySource = functionLine('scheduleSectionErrorRecovery');
  const timers = {};
  const callbacks = [];
  const terminalRuntime = Function('SS','SECTION_RECHECK_TIMERS','setTimeout','document','load','render','fmtStamp',`
    const SECTION_RECHECK_BASE_MS=5000;
    const SECTION_RECHECK_MAX_MS=30000;
    const SECTION_RECHECK_MAX_ATTEMPTS=30;
    const SECTION_ERROR_RECOVERY_MS=60000;
    const SECTION_ERROR_RECOVERY_MAX_ATTEMPTS=3;
    ${recoverySource}
    ${recheckSource}
    return {recheck:scheduleSectionRecheck,recover:scheduleSectionErrorRecovery};
  `)(state,timers,(callback)=>{const id=callbacks.length+1;callbacks.push({callback,id});return id},{visibilityState:'visible'},async name=>{
    state[name]={...state[name],status:'ok',refreshing:false,stale:true,refreshError:'仍未恢复'};
  },()=>{},value=>String(value||''));
  state.homeRankings.recheckAttempt=30;
  state.homeRankings.recoveryAttempt=0;
  terminalRuntime.recheck('homeRankings');
  for(let attempt=0;attempt<3;attempt+=1){
    assert.equal(callbacks.length,attempt+1,`bounded recovery attempt ${attempt+1} is scheduled after the thirtieth recheck`);
    callbacks[attempt].callback();
    await Promise.resolve();
    terminalRuntime.recover('homeRankings');
  }
  terminalRuntime.recover('homeRankings');
  assert.equal(state.homeRankings.status,'degraded_error','G1/G2 data enters an explicit terminal degraded state after 30+3 attempts');
  assert.equal(state.homeRankings.degradedTerminal,true);
  assert.equal(state.homeRankings.generatedAt,'G1');
  assert.equal(state.homeRankings.coreGeneratedAt,'G2','terminal fallback does not rebind the source envelope to G3');
  assert.equal(state.homeRankings.coreRevalidationTargetAt,'G3');
  assert.equal(state.homeRankings.refreshing,false);
  assert.deepEqual(Object.keys(timers),[],'terminal degraded state stops the section timer');
  const terminalSourceState = Function('D','SS',`
    function sectionExpectedAt(){return D.__sections?.generatedAt||D.generatedAt||''}
    ${sourceStateSource}
    return sourceState;
  `)({__sections:{generatedAt:'G3'}},state);
  assert.equal(terminalSourceState('homeRankings',[{sales_sar:12}]),'','terminal degraded state still renders the verified G1 payload');
  state.homeRankings.status='ok';
  state.homeRankings.coreGeneratedAt='G3';
  state.homeRankings.coreRevalidationRequired=false;
  state.homeRankings.degradedTerminal=false;
  assert.equal(sourceState('homeRankings',[{sales_sar:12}]),'','an explicit revalidated degraded response may display G1 with its warning');
}
{
  const terminalStateSource = functionLine('isTerminalDegradedSection');
  const ensureSource = functionLine('ensure');
  assert.ok(terminalStateSource && ensureSource, 'terminal section guard helpers are extractable');
  const state = {
    homeRankings:{status:'degraded_error',degradedTerminal:true,generatedAt:'G1',hasData:true,payload:{sales_sar:12}},
    homeProfit:{status:'ok',degradedTerminal:true,generatedAt:'G1',hasData:true,payload:{profit:12}},
  };
  const before = structuredClone(state);
  const timers = {homeRankings:41,homeProfit:42};
  let fetchCalls = 0;
  const ensure = Function('SS','needsFor','load','sectionStateKey',`
    ${terminalStateSource}
    ${ensureSource}
    return ensure;
  `)(state,()=>['homeRankings','homeProfit'],()=>{fetchCalls+=1;timers.fetch=99},name=>name);
  ensure('home',false);
  assert.equal(fetchCalls,0,'ordinary ensure must not fetch after a terminal degraded state');
  assert.deepEqual(state,before,'ordinary ensure leaves terminal payload and facts unchanged');
  assert.deepEqual(timers,{homeRankings:41,homeProfit:42},'ordinary ensure does not create or alter a timer');
}
{
  const loadSource = source.match(/async function load\([\s\S]*?\n\}\n\/\/ Webhook/)?.[0]?.replace(/\n\/\/ Webhook$/, '') || '';
  const terminalStateSource = functionLine('isTerminalDegradedSection');
  assert.ok(loadSource, 'load implementation is extractable for the force-failure regression');
  const state = {
    homeRankings:{status:'degraded_error',degradedTerminal:true,generatedAt:'G1',cachedAt:'C1',sourceGeneratedAt:'G1',sourceCachedAt:'C1',hasData:true,degraded:true,stale:true,coreGeneratedAt:'G2',coreRevalidationTargetAt:'G3',coreRevalidationRequired:false,automaticRecoveryExhausted:true,refreshing:false,payload:{sales_sar:12}},
  };
  const timers = {};
  const loadHintTimers = [];
  let fetchCalls = 0;
  let scheduledRechecks = 0;
  let scheduledRecoveries = 0;
  const load = Function('D','SS','P','surl','sectionPromiseKey','sectionStateKey','currentQ','isTerminalDegradedSection','clearSectionRecheck','productProfitScopeChanged','clearSectionPayload','scheduleSectionRecheck','scheduleSectionErrorRecovery','portalHttpError','SL','sectionResponseMetadata','portalPublicDetail','portalErrorCode','core','merge','applyLiveOrderRankingOverlay','applyLiveOrderRowsOverlay','applyLivePriceScatterOverlay','dates','render','sectionExpectedAt','LOAD_HINT_MS','fetch','setTimeout',`
    ${loadSource}
    return load;
  `)(
    {__sections:{generatedAt:'G3'}},state,{},name=>'/api/bi/section/'+name,name=>name,name=>name,()=>'',
    Function(`${terminalStateSource}\nreturn isTerminalDegradedSection;`)(),
    name=>{if(timers[name])delete timers[name]},()=>false,()=>{throw new Error('payload must not be cleared')},()=>{scheduledRechecks+=1},()=>{scheduledRecoveries+=1},
    async()=>new Error('force unavailable'),{homeRankings:'首页销售/排行'},()=>({}),()=>'',()=>'',async()=>false,()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},
    4500,
    async()=>{fetchCalls+=1;throw new Error('force unavailable')},(callback)=>{loadHintTimers.push(callback);return loadHintTimers.length},
  );
  const result = await load('homeRankings',false,true,false);
  assert.equal(result,false,'a failed force request remains a failed request to the caller');
  assert.equal(fetchCalls,1,'force still makes its one explicit request');
  assert.equal(state.homeRankings.status,'degraded_error','force failure returns to the terminal degraded state');
  assert.equal(state.homeRankings.generatedAt,'G1','force failure preserves the verified source generation');
  assert.equal(state.homeRankings.payload.sales_sar,12,'force failure preserves the verified old payload');
  assert.equal(state.homeRankings.degradedTerminal,true,'force failure preserves terminal facts');
  assert.equal(state.homeRankings.refreshing,false,'force failure does not leave the page permanently loading');
  assert.deepEqual(Object.keys(timers),[],'force failure leaves no section recovery timer after the terminal result');
  assert.equal(loadHintTimers.length,0,'terminal force failure does not leave a loading-hint timer');
  assert.equal(scheduledRechecks,0);
  assert.equal(scheduledRecoveries,0);
}
{
  const loadSource = source.match(/async function load\([\s\S]*?\n\}\n\/\/ Webhook/)?.[0]?.replace(/\n\/\/ Webhook$/, '') || '';
  const terminalStateSource = functionLine('isTerminalDegradedSection');
  const responseMetadataSource = functionLine('sectionResponseMetadata');
  const responseMetadata = Function(`${responseMetadataSource}\nreturn sectionResponseMetadata;`)();
  const makeRuntime = (body,headers={}) => {
    const state = {
      homeRankings:{status:'degraded_error',degradedTerminal:true,generatedAt:'G1',cachedAt:'C1',sourceGeneratedAt:'G1',sourceCachedAt:'C1',hasData:true,degraded:true,stale:true,coreGeneratedAt:'G2',coreRevalidationTargetAt:'G3',coreRevalidationRequired:false,automaticRecoveryExhausted:true,refreshing:false,recheckAttempt:30,recoveryAttempt:3,payload:{sales_sar:12}},
    };
    const timers = {homeRankings:7};
    const loadHintTimers = [];
    let fetchCalls = 0;
    let mergeCalls = 0;
    let scheduledRechecks = 0;
    let scheduledRecoveries = 0;
    const response = {ok:true,status:200,headers:{get:name=>headers[String(name).toLowerCase()]||''},json:async()=>body};
    const load = Function('D','SS','P','surl','sectionPromiseKey','sectionStateKey','currentQ','isTerminalDegradedSection','clearSectionRecheck','productProfitScopeChanged','clearSectionPayload','scheduleSectionRecheck','scheduleSectionErrorRecovery','portalHttpError','SL','sectionResponseMetadata','portalPublicDetail','portalErrorCode','core','merge','applyLiveOrderRankingOverlay','applyLiveOrderRowsOverlay','applyLivePriceScatterOverlay','dates','render','sectionExpectedAt','LOAD_HINT_MS','fetch','setTimeout',`
      ${loadSource}
      return load;
    `)(
      {__sections:{generatedAt:'G3'}},state,{},name=>'/api/bi/section/'+name,name=>name,name=>name,()=>'',
      Function(`${terminalStateSource}\nreturn isTerminalDegradedSection;`)(),
      name=>{delete timers[name]},()=>false,()=>{throw new Error('old terminal response must not clear payload')},()=>{scheduledRechecks+=1},()=>{scheduledRecoveries+=1},
      async()=>new Error('section unavailable'),{homeRankings:'首页销售/排行'},responseMetadata,()=>'',()=>'',async()=>false,()=>{mergeCalls+=1},()=>{},()=>{},()=>{},()=>{},()=>{},()=>{},
      4500,
      async()=>{fetchCalls+=1;return response},callback=>{loadHintTimers.push(callback);return loadHintTimers.length},
    );
    return {load,state,timers,loadHintTimers,fetchCalls:()=>fetchCalls,mergeCalls:()=>mergeCalls,scheduledRechecks:()=>scheduledRechecks,scheduledRecoveries:()=>scheduledRecoveries};
  };
  const assertTerminalOldResponse = async (runtime,label) => {
    assert.equal(await runtime.load('homeRankings',false,true,false),true,`${label} is handled as a successful stale response`);
    const state=runtime.state.homeRankings;
    assert.equal(runtime.fetchCalls(),1,`${label} makes only the explicit force request`);
    assert.equal(state.status,'degraded_error',`${label} keeps degraded_error`);
    assert.equal(state.degradedTerminal,true,`${label} keeps degradedTerminal`);
    assert.equal(state.generatedAt,'G1',`${label} keeps the G1 source generation`);
    assert.equal(state.sourceGeneratedAt,'G1',`${label} keeps sourceGeneratedAt`);
    assert.equal(state.sourceCachedAt,'C1',`${label} keeps sourceCachedAt`);
    assert.equal(state.recheckAttempt,30,`${label} does not restart the thirty-request budget`);
    assert.equal(state.recoveryAttempt,3,`${label} does not restart the three-attempt recovery budget`);
    assert.equal(state.payload.sales_sar,12,`${label} keeps the old payload`);
    assert.equal(state.refreshing,false,`${label} does not leave permanent loading`);
    assert.deepEqual(Object.keys(runtime.timers),[],`${label} leaves no section timer`);
    assert.equal(runtime.loadHintTimers.length,0,`${label} leaves no loading-hint timer`);
    assert.equal(runtime.mergeCalls(),0,`${label} does not merge the old response body`);
    assert.equal(runtime.scheduledRechecks(),0,`${label} does not restart the thirty-request recheck budget`);
    assert.equal(runtime.scheduledRecoveries(),0,`${label} does not restart the recovery budget`);
  };
  await assertTerminalOldResponse(makeRuntime({generatedAt:'G1',cachedAt:'C1',staleSection:true,data:{rankings:{dailyStores:[{sales_sar:99}]}}}), 'generic G1 stale response');
  await assertTerminalOldResponse(makeRuntime(
    {generatedAt:'G1',cachedAt:'C1',staleSection:true,data:{rankings:{dailyStores:[{sales_sar:99}]}}},
    {
    'x-shein-bi-degraded':'true',
    'x-shein-bi-has-data':'true',
    'x-shein-bi-core-generated-at':'G3',
    'x-shein-bi-source-generated-at':'G1',
    'x-shein-bi-source-cached-at':'C1',
    }), 'explicit degraded G1 response');
  const current = makeRuntime(
    {generatedAt:'G3',cachedAt:'C3',staleSection:false,data:{rankings:{dailyStores:[{sales_sar:99}]}}},
    {
    'x-shein-bi-has-data':'true',
    'x-shein-bi-core-generated-at':'G3',
    });
  assert.equal(await current.load('homeRankings',false,true,false),true,'current G3 response is accepted');
  assert.equal(current.state.homeRankings.status,'ok','current G3 clears degraded_error');
  assert.equal(current.state.homeRankings.degradedTerminal,false,'current G3 clears degradedTerminal');
  assert.equal(current.state.homeRankings.generatedAt,'G3','current G3 owns the accepted response');
  assert.equal(current.state.homeRankings.recoveryAttempt,0,'current G3 clears the previous recovery budget');
  assert.equal(current.mergeCalls(),1,'current G3 body is merged');
  assert.deepEqual(Object.keys(current.timers),[],'current G3 leaves no timer');
}
{
  const responseMetadata = Function(`${functionLine('sectionResponseMetadata')}\nreturn sectionResponseMetadata;`)();
  const metadata = responseMetadata({headers:{get:name=>({
    'x-shein-bi-degraded':'true',
    'x-shein-bi-has-data':'true',
    'x-shein-bi-core-generated-at':'G2',
    'x-shein-bi-source-generated-at':'G1',
    'x-shein-bi-source-cached-at':'2026-08-24T22:37:51Z',
    'x-shein-bi-accounting-pending':'true',
    'x-shein-bi-refresh-scheduled':'true',
  })[String(name).toLowerCase()]||''}}, {generatedAt:'G1'});
  assert.deepEqual(metadata,{degraded:true,hasData:true,coreGeneratedAt:'G2',sourceGeneratedAt:'G1',sourceCachedAt:'2026-08-24T22:37:51Z',accountingPending:true,refreshScheduled:true},
    'the client consumes degraded metadata from headers without changing the source body generation');
}
assert.doesNotMatch(source.match(/async function revalidateCore\(\)[^\n]*/)?.[0] || '', /load\('orders'/,
  'the missed-SSE fallback must not rebuild the large historical orders section');
assert.match(source, /if\(S\.core==='error'\)\{scheduleCoreErrorRecovery\(\);return\}/,
  'a failed core routes visible polling through the bounded recovery scheduler');
assert.match(source, /CORE_ERROR_RECOVERY_BASE_MS=60\*1000[\s\S]*CORE_ERROR_RECOVERY_MAX_ATTEMPTS=3/,
  'core recovery starts at 60s and is capped at three automatic attempts');
assert.match(source, /manual=!silent&&S\.core==='error'.*if\(manual\)resetCoreErrorRecovery\(\)/,
  'the retryCore click path is recognized as manual and resets prior recovery state');
assert.match(source, /if\(manual\)resetCoreErrorRecovery\(\);if\(CORE_PROMISE\)return CORE_PROMISE/,
  'manual retry resets the circuit even if an older automatic request is still settling');
assert.match(source, /S\.core='ok';S\.err='';resetCoreErrorRecovery\(\)/,
  'a successful core request clears attempts and any pending timer');
assert.match(source, /S\.core==='error'&&!manual&&!recovery\)\{scheduleCoreErrorRecovery\(\);return false\}/,
  'SSE and ordinary polling cannot bypass the bounded core recovery circuit');
assert.match(source, /if\(!r\.ok\)throw await portalHttpError\(r,'Core'\)/,
  'core non-2xx responses use the structured actionable error formatter');
assert.match(source, /if\(!r\.ok\)throw await portalHttpError\(r,SL\[n\]\|\|n\)/,
  'section non-2xx responses use the structured actionable error formatter');
assert.match(source, /function scheduleSectionRecheck\(n\)/, 'stale sections schedule an automatic recheck');
assert.match(source, /function scheduleSectionErrorRecovery\(n\).*attempt>=SECTION_ERROR_RECOVERY_MAX_ATTEMPTS.*SECTION_ERROR_RECOVERY_MS/,
  'an exhausted browser error must stop after a bounded low-frequency recovery sequence');
assert.match(source, /SECTION_RECHECK_MAX_ATTEMPTS=30/, 'section rechecks have a hard thirty-request ceiling');
assert.match(source, /SECTION_ERROR_RECOVERY_MAX_ATTEMPTS=3/, 'section recovery has a hard three-attempt ceiling');
const sectionRecoverySource = source.match(/function scheduleSectionErrorRecovery\(n\)[\s\S]*?\nfunction scheduleSectionRecheck/)?.[0] || '';
assert.doesNotMatch(sectionRecoverySource, /recheckAttempt:0/, 'error recovery does not reset the thirty-request recheck budget');
assert.match(source, /recoveryAttempt:Number\(prev\.recoveryAttempt\)\|\|0/, 'a degraded success preserves its recovery-attempt budget');
assert.match(source, /if\(prev\.status==='error'&&!force&&!recheck\)\{scheduleSectionErrorRecovery\(n\);return false\}/,
  'render-time ensure must re-arm recovery instead of permanently pinning a section error');
assert.match(source, /if\(force&&!silent&&!recheck\)\{clearSectionRecheck\(n\);if\(!terminalForce\)prev=\{\.\.\.prev,recoveryAttempt:0,recheckAttempt:0\};[\s\S]*?if\(P\[promiseKey\]\)return P\[promiseKey\]/,
  'manual forced section retries clear a stale timer while terminal facts keep their retry budget');
assert.match(source, /load\(n,true,false,true\)/, 'section rechecks bypass browser state without forcing duplicate generation');
assert.match(source, /if\(needsRecheck\)scheduleSectionRecheck\(n\)/, 'stale or background-refresh responses are polled until current');
assert.match(source, /完成后页面会自动更新/, 'operator copy promises only the implemented automatic update');
const sectionCopySource=source.slice(source.indexOf('function sectionRefreshFailureText'),source.indexOf('\nfunction chips'));
assert.match(sectionCopySource, /有限次自动重试；耗尽后请手动重试/,
  'section failure copy states the finite retry and manual fallback boundary');
assert.doesNotMatch(sectionCopySource, /系统会继续重试|页面会自动重试|系统会自动重试/,
  'section copy must not promise unlimited automatic retry');
assert.match(source, /await core\(\{silent:true,ensureAfter:false\}\)/, 'section version mismatches revalidate core first');
assert.match(source, /versionWarning=.*数据版本与 core 暂未同步/, 'persistent mismatches degrade to an explicit stale warning');
assert.match(source, /const transitionPending=!!\(j\?\.refreshScheduled&&!j\?\.refreshFailed\)/,
  'a scheduled generation transition is distinguished from an actual refresh failure');
assert.match(source, /refreshError:transitionPending\?'':versionWarning/,
  'normal core-to-section convergence must not flash a false refresh-failed message');
assert.doesNotMatch(source, /throw Error\(n\+' generatedAt 不匹配/, 'version mismatches must not hard-fail a usable cached page');
assert.match(source, /history\.pushState\(null,'',hash\)/, 'normal navigation creates browser history');
assert.match(source, /function inventoryMatchStatus\(r\)/, 'client keeps a backward-compatible inventory match-state reader');
assert.match(source, /match==='not_matched'/, 'client must not treat an unmatched ET record as zero stock');
assert.match(source, /match==='stale'/, 'client must surface stale ET snapshots distinctly');
assert.match(source, /仅在 ET 快照最新且已匹配、当前可售为 0、没有有效在途时成立/, 'client out-of-stock copy keeps the fresh-match invariant');
assert.match(source, /function inventoryMatrixLinkOnShelf\(r\)\{return String\(r\?\.openapi_inventory_shelf_status_code\?\?''\)==='1'&&!!r\?\.openapi_inventory_fetched_at\}/,
  'inventory matrix must require a current OpenAPI on-shelf row');
assert.match(source, /function inventoryStoreCellRows\(linkRows\)\{const m=new Map\(\);for\(const r of A\(linkRows\)\)\{if\(!inventoryMatrixLinkOnShelf\(r\)\)continue;/,
  'inventory matrix must discard waiting, sold-out, off-shelf, and stale rows before building store cells');
const inventoryStoreCellSource = source.match(/function inventoryStoreCell\(p,store,cellRows\)\{[\s\S]*?\nfunction inventoryLegend/)?.[0] || '';
assert.match(inventoryStoreCellSource, /shown=saleable!=null\?saleable:display/,
  'inventory matrix uses saleable stock when present and only falls back to display stock when saleable is unavailable');
assert.match(inventoryStoreCellSource, /rows\.map\(inventoryMatrixStockValue\)/,
  'inventory matrix reads current OpenAPI usable stock instead of the daily browser snapshot');
assert.doesNotMatch(inventoryStoreCellSource, /linkStockValue|linkDisplayStockValue|visible_usable_inventory|visible_inventory_quantity/,
  'inventory matrix must not fall back to stale browser inventory fields');
assert.match(inventoryStoreCellSource, /待上架、售罄、已下架及过期快照不参与矩阵/,
  'inventory matrix explains the current OpenAPI on-shelf-only scope');
assert.doesNotMatch(inventoryStoreCellSource, /sold=|wait=|off=/,
  'inventory matrix must not render non-on-shelf status counts or classes');
assert.match(source, /无已上架链接<\/span>/, 'inventory legend does not expose waiting or off-shelf states');
assert.match(source, /front=ls\.frontStockRows>0\?N\(ls\.frontSaleable\):null,frontText=inventoryVirtualQtyText\(front\)/,
  'inventory matrix product totals stay blank when no on-shelf link has a stock value instead of fabricating zero');
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
assert.match(source, /function sourceState\(name,rows=\[\]\)\{[\s\S]*?degradedWithData=state\.degraded===true&&state\.hasData===true[\s\S]*?degradedVisible=[\s\S]*?state\.coreGeneratedAt[\s\S]*?actual!==expected&&!degradedVisible&&!terminalVisible/, 'only an explicit degraded response or terminal degraded state may render an older source generation');
assert.match(source, /function clearSectionPayload\(n,generatedAt=''\)/, 'core transitions clear data owned by an older section generation');
assert.match(source, /clearSectionPayload\(name,generatedAt\);SS\[name\]=\{\.\.\.state,status:'idle'/, 'invalidating a section removes its incompatible payload before rendering');
assert.match(source, /if\(currentExpected&&responseGeneratedAt&&responseGeneratedAt!==currentExpected&&!explicitDegraded\)\{[\s\S]*?stale=true;versionWarning=[\s\S]*?clearSectionPayload\(n,currentExpected\);[\s\S]*?return true\}/, 'a non-degraded old in-flight response is quarantined instead of being merged after a new core arrives');
assert.match(source, /merge\(j,n\)/, 'accepted section payloads record their owning section and generation');
assert.match(source, /function unavailableValue\(\)\{return'<span class=\"metric-unavailable\"><b>—<\/b><small>数据不可用<\/small><\/span>'\}/, 'unavailable KPIs must show an em dash and explicit unavailable copy');
assert.match(source, /function sectionFailureNotice\(ns\).*data-load=.*role=\"alert\".*受影响 KPI 不会显示为 0/, 'failed sections have an actionable top-level alert with retry controls');
assert.match(source, /缓存写入 \$\{fmtStamp\(st\.cachedAt\|\|st\.generatedAt\)\}；页面最新/, 'cache fallback always exposes its cache timestamp and current-page timestamp');
assert.match(source, /sourceGeneratedAt:responseMeta\.sourceGeneratedAt\|\|'',sourceCachedAt:responseMeta\.sourceCachedAt\|\|''/, 'degraded sections retain source generation and cache timestamps separately from core identity');
assert.match(source, /function sectionResponseMetadata\(response,j\).*x-shein-bi-core-generated-at.*x-shein-bi-source-generated-at.*x-shein-bi-source-cached-at/, 'degraded source/core identities are read from response headers');
assert.match(source, /const explicitDegraded=degradedWithData&&Boolean\(responseMeta\.coreGeneratedAt\)/, 'cross-generation degraded display requires explicit core metadata');
assert.match(source, /merge\(j,n\)/, 'section payload merge records the source body generation');
assert.match(source, /会计刷新中，数据截至 \$\{fmtStamp\(accountingAt\)\}，不可按最新判断/, 'accounting-pending homepage data has an explicit stale warning with its source timestamp');
assert.match(source, /const needsRecheck=stale\|\|degraded\|\|accountingPending\|\|refreshScheduled\|\|!!j\.refreshFailed/,
  'a failed background refresh remains on automatic recheck instead of pinning an error in the browser');
assert.match(source, /function sectionRefreshFailureText\(j\).*有限次自动重试；耗尽后请手动重试。当前仍显示上次完整数据/,
  'persistent refresh failures use truthful bounded-retry copy instead of raw server stack text');
assert.match(source, /function sectionNeedsBanner\(n\).*loading=st\.status==='loading'.*slow=loading.*st\.pendingSection.*loading&&\(st\.refreshing\|\|slow\).*actual!==expected.*!st\.refreshing&&st\.refreshError/,
  'pending and visible section refreshes keep the cache status banner on screen');
assert.match(source, /缓存正在刷新.*data-reset-cache=.*重置缓存/,
  'cache refresh banner keeps a visible reset control while data is loading');
assert.match(source, /async function resetSectionCache\(n\).*clearSectionPayload\(n\).*return load\(n,false,true\)/,
  'reset control clears only the current browser section payload and requests a fresh server section');
assert.match(source, /if\(b\.dataset\.resetCache\)\{resetSectionCache\(b\.dataset\.resetCache\);return\}/,
  'cache reset control is wired to the click handler');
assert.match(server, /const BI_FAST_BACKGROUND_SECTIONS = new Set\(\['homeRankings', 'homeProfit'\]\)/,
  'lightweight homepage cache work has a lane independent from multi-minute heavy sections');
assert.match(server, /automatic-retry:\$\{failure\.at\}/,
  'a recorded refresh failure schedules a bounded single-flight retry when the cache is read again');
assert.match(source, /storageEstimated:hp\.reduce\(\(a,r\)=>a\+profitStorageEstimated\(r\),0\)/, 'profit tracks the exact provisional storage amount in the selected range');
assert.match(source, /含待结算预估/, 'provisional storage is labelled as an estimate while remaining deducted from profit');
assert.match(source, /纯历史范围不会再显示“今日待日结”/, 'historical queries never inherit a misleading current-day storage warning');
assert.doesNotMatch(source, /今日仓储费待日结\/未扣/, 'the old undifferentiated and misleading storage warning is removed');
assert.match(source, /chart-readable-details/, 'scatter chart exposes a readable detail path in addition to points');
assert.match(source, /class=\"chart-hit\" data-tip=.*tabindex=\"0\" role=\"img\" aria-label=/, 'trend data points are keyboard focusable and named');
assert.match(source, /if\(j\?\.pendingSection&&!degradedWithData\)/, 'a pending first-generation section stays in loading state while a degraded cache remains renderable');
assert.match(server, /pendingSection: true/,
  'an async first-generation cache miss must be pending, never a successful empty business result');
assert.doesNotMatch(server, /data: \{\}, refreshScheduled, cacheHit: false/,
  'the server must not represent a missing section cache as valid empty data');
assert.match(server, /const key = `\$\{root\}\|\$\{section\}\|\$\{generatedAt \|\| ''\}`;/,
  'normal, warmup, and forced builders must share one single-flight key per section generation');
assert.match(server, /const refreshScheduled = scheduleBiSectionBackgroundGeneration[\s\S]*?readBiSectionStaleRaw\(root, section, meta\.generatedAt, \{[\s\S]*?refreshScheduled/,
  'stale responses must tell the client when a replacement generation is already scheduled');
assert.doesNotMatch(server.match(/function scheduleBiSectionBackgroundGeneration[\s\S]*?\n\}/)?.[0] || '', /\$\{force \? '\|force' : ''\}/,
  'a forced refresh must not create a second concurrent producer key');
assert.match(server, /biSectionLastCompletedRefreshTokens\.get\(key\) === refreshToken[\s\S]*?return false/,
  'multiple browsers receiving the same live event cannot rebuild the same section repeatedly');

console.log('bi_client_resilience: refresh, version fallback, and history contracts passed');
