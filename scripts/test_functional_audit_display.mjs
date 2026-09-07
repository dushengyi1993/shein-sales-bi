#!/usr/bin/env node
// Offline VM regression: real generator mapper, real client functions and click listener.
// Default fixtures contain invented links only. Private evidence requires --audit <path>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {getAliasConfig, getCatalogConfig, normalizeGoodsSnDetailed} from '../lib/product_sku_normalizer.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const client=fs.readFileSync(path.join(root,'scripts/bi_app/client.js'),'utf8');
const generator=fs.readFileSync(path.join(root,'scripts/generate_bi_portal.mjs'),'utf8');
const styles=fs.readFileSync(path.join(root,'scripts/bi_app/styles.css'),'utf8');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const args=process.argv.slice(2);
assert.ok(args.length===0||(args.length===2&&args[0]==='--audit'&&args[1]&&!args[1].startsWith('--')),'Use --audit <path>, or no arguments');

// Evaluate the production generator helper, importing its real registry/catalog resolver.
const mapStart=generator.indexOf('function buildProductAliasSearch(');
const mapEnd=generator.indexOf('const DEFAULT_STORE_OWNER_GROUPS',mapStart);
assert.ok(mapStart>=0&&mapEnd>mapStart);
const mapper=vm.createContext({getAliasConfig,getCatalogConfig,normalizeGoodsSnDetailed});
vm.runInContext(generator.slice(mapStart,mapEnd),mapper);
const attach=data=>{mapper.input=data;return vm.runInContext('attachProductAliasSearch(input)',mapper)};
assert.doesNotMatch(client,/KNOWN_EXACT_CANONICAL_ALIASES/);
assert.doesNotMatch(generator.slice(mapStart,mapEnd),/3065|13065|1713/,'Mapper must not hand-copy model mappings');
assert.ok((generator.match(/AS canonical_goods_sn/g)||[]).length>=4,'Inventory, links and both overlay SQL outputs must label canonical identity');
assert.equal((generator.match(/link_date, store_key, group_key, standard_goods_sn, canonical_goods_sn, raw_goods_sn/g)||[]).length,4,'Link canonical must reach JSON projections, not stop in a CTE');
console.log('[Mapper] Real registry/catalog normalizer and generator attachment loaded; no handwritten model table.');

let now=Date.parse('2026-09-05T03:12:32.251Z');
class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const listeners=new Map();
const ctx=vm.createContext({Date:Clock,console,URL,URLSearchParams,Intl,
  window:{__SHEIN_STORE_CONFIG__:{stores:['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'].map(storeKey=>({storeKey})),ownerGroups:[]},addEventListener(){}},
  location:{hash:'#inventory',search:'',pathname:'/app/'},history:{},navigator:{},
  document:{addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn)},getElementById(){return null},querySelector(){return null},querySelectorAll(){return []}},
  localStorage:{getItem(){return null},setItem(){}},
  fetch(){throw Error('No network allowed in VM')},setTimeout(){return 0},clearTimeout(){},setInterval(){return 0},clearInterval(){},requestAnimationFrame(){return 0},
});
const exports=['D','S','merge','canonicalGoodsSn','pkey','sk','prod','productValidKey','productLinkRows','productCatalog','productSalesRowsInRange','productStatusMatchAnyLink','inventoryLinkRows','inventoryProductKey','inventoryRowsForView','inventoryBuildLinkStats','inventoryStoreCellRows','inventoryStoreCell','inventoryProductMatrix','inventoryEtValue','inventoryIncomingValue','inventorySupplyValue','inventoryLedgerRows','inventoryPage','opsTaskState','opsOpenTaskCount','opsIntentPreview','opsNextAction','opsSummaryKpis','webhookState','webhookSummary'];
const startup='loadAuthUser().catch(()=>{});startLiveUpdates();core();})()';
assert.ok(client.endsWith(startup)||client.trimEnd().endsWith(startup),'Client startup boundary must be explicit');
// Suppress network startup and DOM mounting, but keep the complete production code and event listeners.
vm.runInContext(client.replace(startup,'globalThis.api={'+exports.join(',')+'};ensure=()=>{};render=()=>{globalThis.renderCount=(globalThis.renderCount||0)+1};})()'),ctx);
const api=ctx.api;
function load(data={}){
  for(const key of Object.keys(api.D))delete api.D[key];
  api.merge(attach({storeLinks:[],productStateOverlay:[],inventoryStock:[],inventoryDepletion:{products:[]},...data}),'core');
  Object.assign(api.S,{scope:'ALL',q:'',inventoryStatus:'all',inventoryGroupLimit:120,inventorySortKey:'et',inventorySortDir:'desc'});
}

load({inventoryDepletion:{products:[
 {standard_goods_sn:'FIXTURE-A',inventory_match_status:'matched',current_sellable_quantity:600,et_store_snapshot_date:'2026-09-05',incoming_quantity:null,daily_depletion_qty:10},
 {standard_goods_sn:'FIXTURE-B',inventory_match_status:'matched',current_sellable_quantity:20,et_store_snapshot_date:'2026-09-05',incoming_quantity:30,daily_depletion_qty:1},
]}});
const html=api.inventoryPage();
assert.match(html,/已匹配总库存<\/div><div class="stat-value">至少 650/);
assert.match(html,/1 个货号在途未知/);
assert.match(html,/在途数据不完整，暂不计算/);
const completed={status:'done',lifecycle:{lifecycleStatus:'submitted_readback_matched'},execution:{state:'submitted',preflight:{ok:true},writeAudit:{submitted:true},linkMaintenanceExecutors:[{state:'submitted',readbackStatus:'matched_stock_query_exact'}]}};
assert.equal(api.opsTaskState(completed).done,true);
assert.doesNotMatch(api.opsIntentPreview(completed),/等待你的明确确认/);
assert.match(api.opsNextAction(completed),/本次处理已完成/);
assert.equal(api.opsOpenTaskCount([completed,{status:'archived'},{status:'running'}]),1);
assert.match(api.opsSummaryKpis([], [completed],completed),/本会话 0 件进行中/);
for(const mainStatus of ['running','done'])for(const childStatus of ['failed','running','submitted_but_readback_pending','not_matched']){
 const task={status:mainStatus,execution:{preflight:{ok:true},openApiProductExecutors:[{state:'done'},{state:childStatus}]}};
 assert.equal(api.opsTaskState(task).done,false,mainStatus+' / '+childStatus);
 assert.doesNotMatch(api.opsNextAction(task),/本次处理已完成/);
}
assert.equal(api.opsTaskState({status:'running',execution:{linkMaintenancePrechecks:[{state:'done'}]}}).done,false);
assert.equal(api.opsTaskState({...completed,lifecycle:{lifecycleStatus:'submitted_readback_pending',needsManualResolve:true}}).done,false);
assert.equal(api.opsTaskState({...completed,execution:{...completed.execution,linkMaintenanceExecutors:[{state:'submitted',readbackStatus:'weak_match_only'}]}}).done,false);
for(const status of ['dead_letter','failed']){
 const row={status,eventType:'order',severity:'P1'};
 assert.match(api.webhookSummary(row),/已停止自动重试/);
 assert.doesNotMatch(api.webhookSummary(row),/系统会自动重试/);
}
assert.match(api.webhookSummary({status:'retry',eventType:'order'}),/已进入自动重试队列/);
console.log('functional audit regressions: inventory completeness, whole-task completion and retry copy passed');

assert.equal(api.opsTaskState({...completed,execution:{...completed.execution,linkMaintenanceExecutors:[{state:'done',readbackStatus:'submitted_but_readback_pending'}]}}).done,false);
assert.equal(api.opsTaskState({...completed,execution:{...completed.execution,state:'failed'}}).done,false);
