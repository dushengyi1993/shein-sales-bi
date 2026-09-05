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
const exports=['D','S','merge','canonicalGoodsSn','pkey','sk','prod','productValidKey','productLinkRows','productCatalog','productSalesRowsInRange','productStatusMatchAnyLink','inventoryLinkRows','inventoryProductKey','inventoryRowsForView','inventoryBuildLinkStats','inventoryStoreCellRows','inventoryStoreCell','inventoryProductMatrix','inventoryEtValue','inventoryIncomingValue','inventorySupplyValue','inventoryLedgerRows'];
const startup='loadAuthUser().catch(()=>{});startLiveUpdates();core();})()';
assert.ok(client.endsWith(startup)||client.trimEnd().endsWith(startup),'Client startup boundary must be explicit');
// Suppress network startup and DOM mounting, but keep the complete production code and event listeners.
vm.runInContext(client.replace(startup,'globalThis.api={'+exports.join(',')+'};render=()=>{globalThis.renderCount=(globalThis.renderCount||0)+1};})()'),ctx);
const api=ctx.api;
function load(data={}){
  for(const key of Object.keys(api.D))delete api.D[key];
  api.merge(attach({storeLinks:[],productStateOverlay:[],inventoryStock:[],inventoryDepletion:{products:[]},...data}),'core');
  Object.assign(api.S,{scope:'ALL',q:'',inventoryStatus:'all',inventoryGroupLimit:120,inventorySortKey:'et',inventorySortDir:'desc'});
}
const CAN='SK-GT-3065W蒸汽熨烫机',BASE='SK-GT-3065蒸汽熨烫机',ALIAS='DL-SK-GT-3065W';
const link=(id,qty,extra={})=>({store_key:'DL',skc:'fixture-'+id,standard_goods_sn:CAN,is_on_shelf:true,openapi_inventory_shelf_status_code:'1',openapi_inventory_fetched_at:new Clock().toISOString(),openapi_usable_inventory:qty,...extra});
const et=(qty,stamp='2026-09-05',extra={})=>({standard_goods_sn:CAN,estimated_on_hand_quantity:qty,et_store_snapshot_date:stamp,inventory_match_status:'matched',incoming_quantity:0,...extra});
load({storeLinks:[link('alias',7,{standard_goods_sn:ALIAS})]});
assert.equal(api.D.productCanonicalSnMap[ALIAS],normalizeGoodsSnDetailed(ALIAS).canonical);
assert.equal(api.canonicalGoodsSn({standard_goods_sn:ALIAS}),CAN);
assert.equal(api.canonicalGoodsSn({canonical_goods_sn:'SK-GT-3065W配件',standard_goods_sn:ALIAS}),'SK-GT-3065W配件');
assert.equal(api.canonicalGoodsSn({canonical_goods_sn:'SK-GT-3065W',standard_goods_sn:BASE}),'SK-GT-3065W');
assert.equal(api.canonicalGoodsSn({standard_goods_sn:'SK-GT-3065W配件'}),'SK-GT-3065W配件');
assert.notEqual(api.canonicalGoodsSn({standard_goods_sn:'3065'}),api.canonicalGoodsSn({standard_goods_sn:ALIAS}));
for(const canonical of [...getCatalogConfig().standards,...getCatalogConfig().extraConfirmedStandards]){
  assert.equal(api.canonicalGoodsSn({canonical_goods_sn:canonical,standard_goods_sn:ALIAS}),canonical);
}
api.D.productDisplayNames={UNKNOWN_A:'同名',UNKNOWN_B:'同名'};
assert.notEqual(api.canonicalGoodsSn({standard_goods_sn:'UNKNOWN_A'}),api.canonicalGoodsSn({standard_goods_sn:'UNKNOWN_B'}));
assert.equal(api.inventoryProductKey({product_display_name:'同名'}),'','Unknown product must not acquire a display-name identity');
const savedMap=api.D.productCanonicalSnMap;delete api.D.productCanonicalSnMap;
assert.equal(api.canonicalGoodsSn({standard_goods_sn:ALIAS}),ALIAS,'Absent server map must preserve raw identity');
api.D.productCanonicalSnMap=savedMap;
console.log('[D1] Server canonical retained; real alias mapping, 3065/W split, accessories and unknown same-label models preserved.');

// Explicit canonical identity must survive the whole production path, including same display names.
const identities=[
  {canonical_goods_sn:'CANON-A',standard_goods_sn:ALIAS},
  {canonical_goods_sn:'CANON-B',standard_goods_sn:ALIAS},
  {canonical_goods_sn:'SK-GT-3065W配件',standard_goods_sn:ALIAS},
  {canonical_goods_sn:'SK-GT-3065W',standard_goods_sn:ALIAS},
  {standard_goods_sn:'MODEL-X-3065-SUB'},
  {standard_goods_sn:'MODEL-Y-3065-SUB'},
  {standard_goods_sn:BASE},{standard_goods_sn:CAN}
].map(r=>({...r,product_display_name:'同名'}));
load({storeLinks:identities.map((r,i)=>link('identity-'+i,i+1,r)),inventoryDepletion:{products:identities.map(r=>et(600,undefined,r))}});
{
  const links=api.inventoryLinkRows(),stats=api.inventoryBuildLinkStats(links),rows=api.inventoryRowsForView(links,stats),cells=api.inventoryStoreCellRows(links);
  assert.equal(links.length,8);assert.equal(rows.length,8);assert.equal(stats.size,8);assert.equal(cells.size,8);
  for(let i=0;i<identities.length;i++){
    const expected=identities[i].canonical_goods_sn||identities[i].standard_goods_sn;
    assert.equal(stats.get(expected).frontSaleable,i+1);
    const row=rows.find(r=>api.inventoryProductKey(r)===expected);assert.ok(row);
    assert.ok(api.inventoryStoreCell(row,'DL',cells).includes('<b>'+String(i+1)+'</b>'));
    assert.equal(links[i].raw_goods_sn,identities[i].standard_goods_sn);
  }
}
console.log('[Identity path] 8 distinct canonical/unknown/accessory identities with the same label stay separate in mapper, links, ET, stats and cells.');
api.S.q='SK-GT-3065W';
assert.ok(api.productLinkRows().some(r=>r.canonical_goods_sn==='SK-GT-3065W'),'An explicit server canonical remains searchable even if the alias map maps that spelling elsewhere');
api.S.q='SK-GT-3065W配件';
assert.equal(api.productLinkRows().length,1,'Exact accessory canonical search must not include the machine');
api.S.q='';

// Entire cohorts, all permutations: a third/fourth value cannot erase an earlier conflict.
function permutations(rows){return rows.length<2?[rows]:rows.flatMap((row,i)=>permutations(rows.filter((_,j)=>i!==j)).map(rest=>[row,...rest]));}
let permutationCount=0;
const cases=[
  {rows:[et(600),et(720),et(600)],value:null,state:'conflict'},
  {rows:[et(600),et(720),et(600),et(null)],value:null,state:'conflict'},
  {rows:[et(720,'2026-09-03'),et(600),et(600),et(null)],value:600,state:'known'},
  {rows:[et(720,'2026-09-03'),et(600,'2026-09-03'),et(550)],value:550,state:'known'},
  {rows:[et(600),et(720),et(550,'2026-09-03')],value:null,state:'conflict'},
  {rows:[et(720),et(null),et(null,null)],value:720,state:'known'},
  {rows:[et(600,null),et(600,null),et(null,null)],value:null,state:'missing_timestamp'},
  {rows:[et(720,'invalid'),et(600)],value:600,state:'known'},
];
for(const spec of cases)for(const rows of permutations(spec.rows)){
  load({inventoryDepletion:{products:rows.map((r,i)=>({...r,standard_goods_sn:i%2?ALIAS:CAN}))}});
  const actual=api.inventoryRowsForView();assert.equal(actual.length,1);
  assert.equal(actual[0].estimated_on_hand_quantity,spec.value);
  assert.equal(api.inventoryEtValue(actual[0]),spec.value);
  assert.equal(actual[0].et_evidence_status,spec.state);
  const html=api.inventoryProductMatrix(actual,[],new Map());
  assert.ok(html.includes('<b>'+(spec.value==null?'未知':String(spec.value))+'</b>'));
  if(spec.state==='conflict')assert.match(html,/同期 ET 快照冲突/);
  permutationCount++;
}
console.log('[ET] '+permutationCount+' cohort permutations passed: persistent conflict, latest known stock, missing/invalid time unknown.');

// Same timestamp conflict for transit must also survive a later normal alias row.
for(const rows of permutations([et(600,undefined,{incoming_quantity:7}),et(600,undefined,{incoming_quantity:11}),et(600,undefined,{incoming_quantity:7})])){
  load({inventoryDepletion:{products:rows}});
  const row=api.inventoryRowsForView()[0];
  assert.equal(api.inventoryIncomingValue(row),null);
  assert.equal(api.inventorySupplyValue(row),null);
}
// A non-conflicting known record is not overwritten by an alias null; virtual stocks stay additive.
load({storeLinks:[link('alias',7,{standard_goods_sn:ALIAS}),link('standard',11)],inventoryDepletion:{products:[et(600,undefined,{cost_shipped_quantity:720}),et(null,null,{standard_goods_sn:ALIAS,cost_shipped_quantity:240})]}});
let links=api.inventoryLinkRows(),stats=api.inventoryBuildLinkStats(links),rows=api.inventoryRowsForView(links,stats),cells=api.inventoryStoreCellRows(links);
assert.equal(links.length,2);assert.equal(stats.get(CAN).linkRows,2);assert.equal(stats.get(CAN).frontSaleable,18);
assert.equal(rows.length,1);assert.equal(api.inventoryEtValue(rows[0]),600);assert.equal(rows[0].cost_shipped_quantity,720);
assert.match(api.inventoryStoreCell(rows[0],'DL',cells),/<b>18<\/b>/);
assert.match(api.inventoryProductMatrix(rows,links,stats),/虚拟 18/);
console.log('[D1/D2] Real links -> stats -> ledger -> matrix/cell: 7+11=18, 2 SKCs, 1 ET row (600).');

// Browser counterexample: searching the full W name used to drop the alias's 7.
// Producer mappings, rather than display labels, define the searchable group.
for(const overlayOnly of [false,true]){
  load({storeLinks:[link('search-alias',7,{standard_goods_sn:ALIAS}),
    ...(!overlayOnly?[link('search-standard',11)]:[]),
    link('search-other-store',13,{store_key:'CX'}),link('search-base',23,{standard_goods_sn:BASE})],
    productStateOverlay:overlayOnly?[link('search-standard',11,{event_at:new Clock().toISOString()})]:[],
    inventoryDepletion:{products:[et(600),et(600,undefined,{standard_goods_sn:ALIAS}),et(90,undefined,{standard_goods_sn:BASE})]}});
  assert.equal(api.D.productDisplayNames?.[ALIAS],undefined,'No display-name rescue for the original browser failure');
  for(const q of ['3065W','SK-GT-3065W',CAN,ALIAS,ALIAS.toLowerCase()]){
    api.S.q=q;api.S.scope='DL';
    const selected=api.inventoryLinkRows(),summary=api.inventoryBuildLinkStats(selected),ledger=api.inventoryRowsForView(selected,summary);
    assert.equal(selected.length,2,q+' retains both store+SKC entities across source/overlay');
    assert.ok(selected.every(r=>api.canonicalGoodsSn(r)===CAN));
    assert.equal(summary.get(CAN).frontSaleable,18,q+' conserves 7+11');
    assert.equal(ledger.length,1);assert.equal(api.inventoryEtValue(ledger[0]),600,q+' preserves shared ET once');
    assert.match(api.inventoryStoreCell(ledger[0],'DL',api.inventoryStoreCellRows(selected)),/<b>18<\/b>/);
    assert.match(api.inventoryProductMatrix(ledger,selected,summary),/虚拟 18/);
    assert.deepEqual(Array.from(api.productCatalog(selected),r=>r.key),[CAN],q+' remains visible in the product catalog');
    api.S.scope='ALL';
    assert.equal(api.inventoryBuildLinkStats(api.inventoryLinkRows()).get(CAN).frontSaleable,31,'Store filter still controls 18 versus 31');
  }
  for(const q of ['3065',BASE]){
    api.S.q=q;api.S.scope='DL';
    const selected=api.inventoryLinkRows();
    assert.equal(selected.length,1,q+' resolves the producer exact base alias without including W');
    assert.equal(api.canonicalGoodsSn(selected[0]),BASE);assert.equal(selected[0].openapi_usable_inventory,23);
  }
}
// A matched row can expose only its canonical peers, never a distinct same-name model.
load({storeLinks:[link('scope-a',7,{canonical_goods_sn:'QA-SCOPE-A',raw_goods_sn:'legitimate-row-alias',product_display_name:'Shared label'}),
  link('scope-a-peer',11,{canonical_goods_sn:'QA-SCOPE-A',product_display_name:'Shared label'}),
  link('scope-b',29,{canonical_goods_sn:'QA-SCOPE-B',product_display_name:'Shared label'})],
  inventoryDepletion:{products:[et(600,undefined,{canonical_goods_sn:'QA-SCOPE-A'}),et(90,undefined,{canonical_goods_sn:'QA-SCOPE-B'})]}});
api.S.q='legitimate-row-alias';
assert.equal(api.inventoryLinkRows().length,2,'Row alias exposes its canonical group only');
assert.equal(api.inventoryEtValue(api.inventoryRowsForView()[0]),600,'Matched link group retains canonical ET evidence');
// Search must not relax date, store, or downstream shelf-status restrictions.
load({productSalesDaily:[{store_key:'DL',standard_goods_sn:ALIAS,canonical_goods_sn:CAN,date:'2026-09-05'},
  {store_key:'DL',standard_goods_sn:CAN,date:'2026-09-04'},
  {store_key:'CX',standard_goods_sn:CAN,date:'2026-09-05'}]});
api.S.q=CAN;api.S.scope='DL';
assert.equal(api.productSalesRowsInRange('2026-09-05','2026-09-05').length,1);
assert.equal(api.productStatusMatchAnyLink(link('off',1,{is_on_shelf:false,is_out_shelf:true}),['on']),false);
console.log('[Search] Full canonical, short W code and exact raw alias conserve DL 18 / all stores 31 / shared ET 600; base 3065, same-label identities and scope filters stay separate.');

// Entity dedupe keeps overlay status updates and legitimate distinct SKCs.
load({storeLinks:[link('a',7),link('a',7,{standard_goods_sn:ALIAS}),link('b',11),link('base',3,{standard_goods_sn:BASE})],productStateOverlay:[{store_key:'DL',skc:'fixture-a',standard_goods_sn:ALIAS,is_on_shelf:false,is_out_shelf:true,shelf_status_code:'4'},{store_key:'DL',skc:'fixture-new',standard_goods_sn:CAN,is_on_shelf:true}]});
links=api.productLinkRows();assert.equal(links.length,4);assert.equal(new Set(links.map(r=>r.store_key+'|'+r.skc)).size,4);
assert.equal(links.find(r=>r.skc==='fixture-a').is_out_shelf,true);assert.equal(links.filter(r=>r.standard_goods_sn===CAN).length,3);

function displayCase(input,label,counts,cellPattern,summaryPattern){
  load({storeLinks:input});const links=api.inventoryLinkRows(),stats=api.inventoryBuildLinkStats(links),rows=api.inventoryRowsForView(links,stats);
  const cellMap=api.inventoryStoreCellRows(links);
  assert.equal(cellMap.get('DL|'+CAN).length,input.length,label+' links retained before cell');
  const summary=stats.get(CAN);
  for(const [key,value] of Object.entries(counts))assert.equal(summary[key],value,label+' '+key);
  const cell=api.inventoryStoreCell(rows[0],'DL',cellMap),matrix=api.inventoryProductMatrix(rows,links,stats);
  assert.match(cell,cellPattern,label);assert.match(matrix,summaryPattern,label+' matrix summary');
  return cell;
}
const fresh=new Clock().toISOString(),old=new Clock(now-45*60*1000-1).toISOString();
const zeroPart=displayCase([link('a',0),link('b',110)],'partial zero',{frontSaleable:110,frontStockRows:2,frontUnknownRows:0,zeroRows:1},/<b>110<\/b>/,/虚拟 110/);
assert.match(zeroPart,/inventory-store-cell zero-part/);assert.match(zeroPart,/部分链接缺货/);
displayCase([link('a',100),link('b',null)],'unknown',{frontSaleable:100,frontStockRows:1,frontUnknownRows:1},/已知 100 \/ 另有未知/,/虚拟 100\(含未知\)/);
displayCase([link('a',50),link('b',30,{openapi_inventory_fetched_at:old})],'mixed expired',{frontSaleable:50,frontStockRows:1,frontExpiredRows:1},/已知 50 \/ 含过期/,/虚拟 50\(含过期\)/);
displayCase([link('a',50),link('b',30,{openapi_inventory_fetched_at:null})],'mixed missing time',{frontSaleable:50,frontStockRows:1,frontUnknownRows:1,frontMissingTimeRows:1},/已知 50 \/ 含缺时间/,/虚拟 50\(含未知\)/);
for(const stamp of [null,'invalid']){
  displayCase([link('a',100,{openapi_inventory_fetched_at:stamp})],'missing/invalid',{frontSaleable:0,frontStockRows:0,frontUnknownRows:1,frontMissingTimeRows:1},/<b>未知<\/b>/,/虚拟 未知/);
}
for(const stamp of [old,new Clock(now+1).toISOString()]){
  displayCase([link('a',100,{openapi_inventory_fetched_at:stamp})],'expired/future',{frontSaleable:0,frontStockRows:0,frontExpiredRows:1},/<b>过期<\/b>/,/虚拟 过期/);
}
displayCase([link('a',null,{openapi_inventory_quantity:80})],'total only',{frontSaleable:0,frontStockRows:0,frontUnknownRows:1},/未知\(总 80\)/,/虚拟 未知/);
displayCase([link('a',50),link('b',null),link('c',30,{openapi_inventory_fetched_at:old})],'unknown plus expired',{frontSaleable:50,frontStockRows:1,frontUnknownRows:1,frontExpiredRows:1},/已知 50 \/ 另有未知 \/ 含过期/,/虚拟 50\(含未知、含过期\)/);
// Same cached rows cross the exact age boundary without data reload.
load({storeLinks:[link('clock',100)]});links=api.inventoryLinkRows();cells=api.inventoryStoreCellRows(links);
now+=45*60*1000;assert.match(api.inventoryStoreCell({standard_goods_sn:CAN},'DL',cells),/<b>100<\/b>/);
now+=1;assert.match(api.inventoryStoreCell({standard_goods_sn:CAN},'DL',cells),/<b>过期<\/b>/);
assert.equal(api.inventoryBuildLinkStats(links).get(CAN).frontExpiredRows,1);now=Date.parse(fresh);
for(const selector of ['.inventory-store-cell.zero-part','.inventory-legend .zero-part']){
  const block=styles.slice(styles.indexOf(selector)).split('}')[0];assert.match(block,/background\s*:/);assert.match(block,/color\s*:/);
}
console.log('[D2] CellRows first: partial zero, known+unknown, mixed expired, missing/invalid/future, total-only, 45-minute boundary and actual CSS passed.');

// Capture and invoke the real delegated click listener, not a handwritten increment.
load();const products=Array.from({length:121},(_,i)=>({standard_goods_sn:'FIXTURE-'+String(i).padStart(3,'0')}));
const click=(listeners.get('click')||[]).find(fn=>String(fn).includes('inventoryMatrixMore'));
assert.ok(click,'Production click listener not installed');
let html=api.inventoryProductMatrix(products,[],new Map());
const rendered=h=>(h.match(/class="cell product inventory-product-cell"/g)||[]).length;
assert.equal(rendered(html),120);assert.match(html,/当前 120 \/ 共 121 个/);
click({target:{closest:selector=>selector==='button'?{dataset:{inventoryMatrixMore:'1'}}:null}});
assert.equal(api.S.inventoryGroupLimit,160);assert.equal(ctx.renderCount,1);
html=api.inventoryProductMatrix(products,[],new Map());assert.equal(rendered(html),121);assert.doesNotMatch(html,/data-inventory-matrix-more/);
console.log('[Matrix synthetic] 121 input rows; 120 before real click, 121 after; render invoked once.');

if(args.length){
  let auditStage='manifest';
  try {
  const auditPath=path.resolve(args[1]);
  // Fail on missing requested file; never silently skip an explicitly requested audit.
  const manifest=JSON.parse(fs.readFileSync(auditPath+'.manifest.json','utf8'));
  const expected='a4576550abed5c2a917857cc7d69a7248e005fb28120506607e37cc07d8417f4';
  assert.equal(manifest.run.outcome,'succeeded');assert.equal(manifest.run.readOnly,true);assert.equal(manifest.run.coverage.issueCount,0);
  assert.equal(manifest.run.source.authority,'cloud_bi_query_data');
  for(const section of ['linksData','inventoryTrend'])assert.ok(manifest.run.coverage.loadedSections.includes(section));
  const artifact=manifest.artifacts.find(r=>r.path===path.basename(auditPath));assert.ok(artifact);assert.equal(artifact.sha256,expected);
  auditStage='artifact size/hash';
  const bytes=fs.readFileSync(auditPath);assert.equal(bytes.length,artifact.bytes);assert.equal(sha(bytes),expected);
  const data=JSON.parse(bytes.toString('utf8')).data;
  console.log('[Audit] Manifest outcome/coverage/provenance, bytes='+bytes.length+' and expected SHA verified before parsing data.');
  auditStage='entity regression';
  now=Date.parse(manifest.run.finishedAt);load(data);
  // Reproduce the documented old compound key from the immutable snapshot only.
  // This is explicitly a reference reducer, not execution of a Git baseline checkout.
  const oldMap=new Map();
  const legacyEligible=r=>api.sk(r)&&r.skc&&api.productValidKey(api.pkey(r));
  for(const r of data.storeLinks.filter(legacyEligible))oldMap.set([api.sk(r),api.pkey(r),r.skc].join('|'),r);
  for(const r of data.productStateOverlay.filter(legacyEligible)){
    const key=[api.sk(r),api.pkey(r),r.skc].join('|');if(!oldMap.has(key))oldMap.set(key,r);
  }
  const countDuplicates=rs=>{const counts=new Map();for(const r of rs){const k=api.sk(r)+'|'+r.skc;counts.set(k,(counts.get(k)||0)+1)}return Array.from(counts.values()).filter(n=>n>1).length};
  const oldDuplicateCount=countDuplicates([...oldMap.values()]);assert.equal(oldDuplicateCount,48);
  const fixed=api.productLinkRows();assert.equal(countDuplicates(fixed),0);
  const expectedEntities=new Set([...data.storeLinks,...data.productStateOverlay].filter(legacyEligible).map(r=>api.sk(r)+'|'+r.skc));
  const actualEntities=new Set(fixed.map(r=>api.sk(r)+'|'+r.skc));assert.deepEqual(actualEntities,expectedEntities);
  const byProduct=new Map();for(const r of fixed){const k=api.sk(r)+'|'+api.canonicalGoodsSn(r);if(!byProduct.has(k))byProduct.set(k,new Set());byProduct.get(k).add(r.skc)}
  const multiLinkGroups=[...byProduct.values()].filter(s=>s.size>1).length;
  console.log('[Audit entities] '+JSON.stringify({storeLinks:data.storeLinks.length,overlay:data.productStateOverlay.length,legacyRows:oldMap.size,legacyDuplicateEntities:oldDuplicateCount,mergedEntities:fixed.length,duplicateEntities:0,legitimateMultiLinkGroups:multiLinkGroups}));
  auditStage='inventory canonical/matrix regression';
  const canonicalMap=api.D.productCanonicalSnMap;api.D.productCanonicalSnMap={};
  const rawCombinedRows=api.inventoryRowsForView(api.productLinkRows()).length;api.D.productCanonicalSnMap=canonicalMap;
  const inventory=api.inventoryRowsForView(fixed),keys=new Set(inventory.map(api.inventoryProductKey));
  const ledgerCanonical=new Set(data.inventoryDepletion.products.map(api.canonicalGoodsSn));
  assert.equal(keys.size,inventory.length);
  assert.equal(inventory.filter(r=>api.inventoryProductKey(r)===CAN).length,1);
  assert.ok(inventory.some(r=>api.inventoryProductKey(r)===BASE));
  const inventoryLinks=api.inventoryLinkRows(),auditStats=api.inventoryBuildLinkStats(inventoryLinks),auditCells=api.inventoryStoreCellRows(inventoryLinks);
  const matrix=api.inventoryProductMatrix(inventory,inventoryLinks,auditStats);
  assert.equal(rendered(matrix),Math.min(120,inventory.length));
  assert.ok([...auditCells.keys()].every(k=>keys.has(k.slice(k.indexOf('|')+1))));
  console.log('[Audit inventory] '+JSON.stringify({rawCombinedRows,rawLedgerRows:data.inventoryDepletion.products.length,canonicalLedgerRows:ledgerCanonical.size,combinedMatrixRows:inventory.length,duplicateCanonicalRows:inventory.length-keys.size,renderedMatrixRows:rendered(matrix),canonicalWithLinkStats:auditStats.size}));
  console.log('[Audit boundary] Above matrix count is measured from the private snapshot; 121 is the separate synthetic click fixture.');
  } catch {
    console.error('[Audit] FAILED at '+auditStage+'; private evidence details suppressed.');
    process.exitCode=1;
  }
}else console.log('[Audit] Not requested; default CI uses synthetic fixtures only.');
if(!process.exitCode)console.log('PASS V6 D1/D2 real generator/client VM');
