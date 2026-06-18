#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {requireStoreIdentitySnapshot, storeIdentityEvalBody} from '../../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config/stores.json'), 'utf8'));
const STORES = STORES_CONFIG.stores || [];
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config/store_account_truth.json'), 'utf8'));
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp/marketing-signup/limited-discount-rescue/mixed-limited-recreate-results');

function parseArgs(argv){
  const args={plan:'', storeKey:'', port:0, execute:false, outDir:DEFAULT_OUT_DIR, startDelayMinutes:10};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--plan') args.plan=path.resolve(argv[++i]||'');
    else if(a.startsWith('--plan=')) args.plan=path.resolve(a.slice(7));
    else if(a==='--store-key'||a==='--store') args.storeKey=String(argv[++i]||'').toUpperCase();
    else if(a.startsWith('--store-key=')) args.storeKey=String(a.slice(12)||'').toUpperCase();
    else if(a.startsWith('--store=')) args.storeKey=String(a.slice(8)||'').toUpperCase();
    else if(a==='--port') args.port=Number(argv[++i]);
    else if(a.startsWith('--port=')) args.port=Number(a.slice(7));
    else if(a==='--execute') args.execute=true;
    else if(a==='--dry-run') args.execute=false;
    else if(a==='--out-dir') args.outDir=path.resolve(argv[++i]||'');
    else if(a.startsWith('--out-dir=')) args.outDir=path.resolve(a.slice(10));
    else if(a==='--start-delay-minutes') args.startDelayMinutes=Number(argv[++i]);
    else if(a.startsWith('--start-delay-minutes=')) args.startDelayMinutes=Number(a.slice(22));
    else throw new Error(`Unknown argument: ${a}`);
  }
  if(!args.plan) throw new Error('Missing --plan');
  if(!args.storeKey) throw new Error('Missing --store-key');
  if(!Number.isFinite(args.port)||args.port<=0) throw new Error('Invalid --port');
  if(!Number.isFinite(args.startDelayMinutes)||args.startDelayMinutes<1) throw new Error('Invalid --start-delay-minutes');
  return args;
}
function rel(p){ return path.relative(ROOT,p).replaceAll(path.sep,'/'); }
function parseChinaDate(v){ if(!v) return null; const d=new Date(String(v).replace(' ','T')+'+08:00'); return Number.isFinite(d.getTime())?d:null; }
function fmtDate(date){ const p=n=>String(n).padStart(2,'0'); return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`; }
async function httpJson(url){ const res=await fetch(url); if(!res.ok) throw new Error(`${url} ${res.status}`); return await res.json(); }
class Cdp{ constructor(ws){this.wsUrl=ws;this.seq=0;this.pending=new Map();} async connect(){this.ws=new WebSocket(this.wsUrl); this.ws.addEventListener('message',ev=>{const msg=JSON.parse(ev.data); if(msg.id&&this.pending.has(msg.id)){const it=this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(it.timer); msg.error?it.reject(new Error(JSON.stringify(msg.error))):it.resolve(msg.result);}}); await new Promise((res,rej)=>{this.ws.addEventListener('open',res,{once:true}); this.ws.addEventListener('error',rej,{once:true});}); await this.call('Runtime.enable');} call(method,params={}){const id=++this.seq; this.ws.send(JSON.stringify({id,method,params})); return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id); reject(new Error(`CDP timeout ${method}`));},180000); this.pending.set(id,{resolve,reject,timer});});} async eval(body,arg){const encoded = arg === undefined ? 'undefined' : JSON.stringify(arg).replace(/</g,'\\u003c'); const res=await this.call('Runtime.evaluate',{expression:`(async()=>{ const __arg=${encoded}; ${body} })()`,awaitPromise:true,returnByValue:true,userGesture:true}); if(res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails,null,2)); return res.result.value;} close(){try{this.ws.close();}catch{}} }
async function connect(port){ const pages=await httpJson(`http://127.0.0.1:${port}/json/list`); const page=pages.find(p=>p.type==='page'&&String(p.url||'').includes('sso.geiwohuo.com'))||pages.find(p=>p.type==='page'); if(!page) throw new Error(`No page at ${port}`); const c=new Cdp(page.webSocketDebuggerUrl); await c.connect(); return c; }
async function assertIdentity(cdp, store, context){ const snap=await cdp.eval(storeIdentityEvalBody()); return requireStoreIdentitySnapshot({store, truth: STORE_ACCOUNT_TRUTH.stores?.[store.storeKey], snapshot:snap, context}); }

const args=parseArgs(process.argv.slice(2));
await fs.mkdir(args.outDir,{recursive:true});
const plan=JSON.parse(await fs.readFile(args.plan,'utf8'));
if(String(plan.storeKey||'').toUpperCase()!==args.storeKey) throw new Error(`plan store ${plan.storeKey} != args ${args.storeKey}`);
const store=STORES.find(s=>String(s.storeKey).toUpperCase()===args.storeKey);
if(!store) throw new Error(`Unknown store ${args.storeKey}`);
const old=plan.oldActivity||{};
if(!old.id) throw new Error('plan missing oldActivity.id');
const allRows=(plan.groups||[]).flatMap(g=>(g.rows||[]).map(r=>({...r, group:g.group, groupEndTime:g.endTime, activityNamePrefix:g.activityNamePrefix})));
if(!allRows.length) throw new Error('plan groups empty');
const expectedSet=[...new Set(plan.expectedOldSkcs||allRows.map(r=>r.skc))].sort();
if(expectedSet.length!==allRows.length) throw new Error('expected SKCs and rows length mismatch or duplicate');

const cdp=await connect(args.port);
let outPath;
try{
  const identity=await assertIdentity(cdp, store, 'split_recreate_mixed_limited_discount');
  const result=await cdp.eval(`
    const {plan, allRows, expectedSet, execute, startDelayMinutes}=__arg;
    const headers={'content-type':'application/json;charset=UTF-8'};
    async function post(api, body){
      const res=await fetch('/mrs-api-prefix'+api,{method:'POST',headers,credentials:'include',body:JSON.stringify(body)});
      const text=await res.text(); let json; try{json=JSON.parse(text)}catch{}
      if(!res.ok || !json || json.code!=='0') throw new Error(api+' '+res.status+' '+text.slice(0,800));
      return json;
    }
    const oldId=Number(plan.oldActivity.id);
    const oldDetail=await post('/promotion/obm/query_obm_activity_detail',{activity_id:oldId,system:'mrs'});
    const oldGoodsPacket=await post('/promotion/simple_platform/query_activity_goods',{activity_id:oldId,page_num:1,page_size:1000});
    const oldGoods=oldGoodsPacket.info?.data || oldGoodsPacket.info || [];
    const oldSkcs=[...new Set(oldGoods.map(g=>String(g.skc||'')))].sort();
    const expected=[...expectedSet].sort();
    const sameSet=oldSkcs.length===expected.length && oldSkcs.every((s,i)=>s===expected[i]);
    const oldActivity=oldDetail.info || {};
    const state=Number(oldActivity.state ?? oldActivity.base_info?.state ?? oldActivity.activity_base_info?.state ?? 0);
    const oldSummary={activity_id:oldId, state, act_name:oldActivity.act_name || oldActivity.base_info?.act_name || plan.oldActivity.name, start_time:oldActivity.start_time || plan.oldActivity.start, end_time:oldActivity.end_time || plan.oldActivity.end, oldSkcs, expected, sameSet, goods: oldGoods.map(g=>({skc:g.skc, supplier:g.sku_supplier_no, price:g.product_act_price, state:g.goods_state, id:g.id}))};
    if(!sameSet) return {ok:false, execute, reason:'old activity goods set mismatch', oldSummary};
    if(![2,3].includes(state)) return {ok:false, execute, reason:'old activity state not wait/start', oldSummary};

    const apolloRaw=localStorage.getItem('front-config') || '{}';
    let apollo={}; try{apollo=JSON.parse(apolloRaw)}catch{}
    const pricing_type=2;
    function pad(n){return String(n).padStart(2,'0')}
    function fmt(date){return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+' '+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds())}
    function round2(n){return Math.round(Number(n)*100)/100}
    function buildBase(prefix,endTime){return {act_name: prefix + fmt(new Date()).slice(0,10).replaceAll('-',''), zone_start_time: fmt(new Date(Date.now()+startDelayMinutes*60000)), zone_end_time:endTime, time_zone:'Asia/Shanghai', ref_tool_id:175, activity_rule:{goods_limit:0, goods_limit_num:null}}}
    function buildRows(goodsRows, checkInfo, rows, options={}){
      const allowPreEndLimitedOccupied = !!options.allowPreEndLimitedOccupied;
      const map=new Map(goodsRows.map(g=>[String(g.skc||''),g]));
      const tools=checkInfo?.query_tools_rule_detail?.tools_rule || {};
      const minDefault=Number(tools.min_stock ?? 3); const maxDefault=Number(tools.max_stock ?? 10000);
      const missing=[]; const invalid=[]; const add=[]; const detail=[];
      for(const target of rows){
        const good=map.get(target.skc); if(!good){missing.push(target.skc); continue;}
        const supply=good.supply_price_info || {}; const price=round2(target.limitedDiscountPrice);
        const supplyPrice=Number(supply.supply_price); const maxSupplyPrice=Number(supply.max_supply_price);
        const intercept=Number(supply.intercept_supply_price ?? (Number.isFinite(supplyPrice)&&Number.isFinite(Number(good.rate_intercept)) ? supplyPrice*(1-Number(good.rate_intercept)/100) : NaN));
        const inventory=Number(good.inventory_num ?? good.ivt_num ?? 0); const minStock=Number(good.check_stock?.min_stock ?? minDefault); const maxStock=Number(good.check_stock?.max_stock ?? maxDefault);
        const attendNum=Math.max(minStock, Math.min(maxStock, inventory));
        const errorCode=String(good.error_code || '');
        if(errorCode){
          const occupiedByOldLimited = allowPreEndLimitedOccupied && errorCode === 'mrs-simple_platform_limit_discounts-0006';
          invalid.push({skc:target.skc, reason:'query_goods error_code', error_code:errorCode, allowedPreEndLimitedOccupied: occupiedByOldLimited});
        }
        if(!Number.isFinite(price)||price<=0) invalid.push({skc:target.skc, reason:'invalid target price', price});
        if(Number.isFinite(maxSupplyPrice)&&price>maxSupplyPrice+0.0001) invalid.push({skc:target.skc, reason:'price exceeds max_supply_price', price, maxSupplyPrice});
        if(Number.isFinite(intercept)&&price<=intercept+0.0001) invalid.push({skc:target.skc, reason:'price hits rate_intercept floor', price, interceptSupplyPrice:intercept});
        if(!Number.isFinite(inventory)||inventory<minStock) invalid.push({skc:target.skc, reason:'inventory below min_stock', inventory, minStock});
        const isSale=Number(good.is_sale_attribute)===1;
        const addSkuList=Array.isArray(good.sku_info_list) ? good.sku_info_list.map(sku=>{const si=sku.supply_price_info||{}; const row=isSale?{id:sku.id,cost_price:Number(si.supply_price),sku:sku.sku,max_product_act_price:Number(si.max_supply_price),product_act_price:price}:{id:sku.id,cost_price:0,sku:sku.sku,max_product_act_price:0,product_act_price:0}; Object.keys(row).forEach(k=>row[k]===undefined&&delete row[k]); return row;}) : [];
        const row={attend_num:attendNum,center_list:good.effective_center_list||[],id:good.id,is_sale_attribute:good.is_sale_attribute,promotion_id_list:good.effective_promotion_id_list||null,skc:good.skc,stock_num:Number(good.ivt_num||good.inventory_num||0),cost_price:isSale?0:supplyPrice,max_product_act_price:isSale?0:maxSupplyPrice,product_act_price:isSale?0:price,add_sku_list:addSkuList};
        Object.keys(row).forEach(k=>row[k]===undefined&&delete row[k]); add.push(row);
        detail.push({skc:target.skc,supplierNo:good.sku_supplier_no||target.supplierNo,price,inventory,attendNum,maxSupplyPrice,interceptSupplyPrice:intercept,role:target.role,group:target.group});
      }
      const hardInvalid = invalid.filter(item => !item.allowedPreEndLimitedOccupied);
      const allowedPreEndLimitedOccupied = invalid.filter(item => item.allowedPreEndLimitedOccupied);
      return {missing,invalid,hardInvalid,allowedPreEndLimitedOccupied,add,detail};
    }
    const groupResults=[];
    for(const group of plan.groups){
      const base=buildBase(group.activityNamePrefix, group.endTime);
      const check=await post('/promotion/simple_platform/check_activity', base);
      const effective=check.info?.effective_center_list || [];
      const q=await post('/promotion/simple_platform/query_goods',{page_size:500,page_num:1,activity_base_info_request:{...base,sub_type_id:2},effective_center_list:effective,skc_list:(group.rows||[]).map(r=>r.skc),is_shelf:1});
      const goods=q.info?.data || q.info || [];
      const built=buildRows(goods, check.info, group.rows||[], {allowPreEndLimitedOccupied:true});
      groupResults.push({group:group.group, endTime:group.endTime, activityNamePrefix:group.activityNamePrefix, base, validation:{missing:built.missing, invalid:built.invalid, hardInvalid:built.hardInvalid, allowedPreEndLimitedOccupied:built.allowedPreEndLimitedOccupied, addRows:built.add.length, expected:(group.rows||[]).length}, plannedGoods:built.detail, createPayload:{activity_base_info_request:{...base,notify_flag:1,sub_type_id:2}, pricing_type, add_cost_and_stock_info_list:built.add, update_cost_and_stock_info_list:[], delete_cost_and_stock_info_list:[]}, rows: group.rows||[]});
    }
    const validationFailed=groupResults.some(g=>g.validation.missing.length || g.validation.hardInvalid.length || g.validation.addRows!==g.validation.expected);
    const result={ok:false, execute, oldSummary, groups:groupResults, validationFailed, ended:null, created:[], after:null};
    if(validationFailed){ result.reason='validation failed before ending old activity'; return result; }
    if(!execute){ result.ok=true; result.dryRunOnly=true; return result; }
    const actionState=state===3?6:5;
    const endPacket=await post('/promotion/obm/undo_or_end_obm_activity',{activity_id:oldId,promotion_action_state:actionState});
    result.ended={activity_id:oldId, previous_state:state, promotion_action_state:actionState, response:{code:endPacket.code,msg:endPacket.msg,info:endPacket.info}};
    async function oldStillActive(){
      const detail=await post('/promotion/obm/query_obm_activity_detail',{activity_id:oldId,system:'mrs'});
      const st=Number((detail.info||{}).state ?? (detail.info||{}).base_info?.state ?? 0);
      return {state:st, info:detail.info};
    }
    let endedOk=false; let endedState=null;
    for(let i=0;i<8;i++){ await new Promise(r=>setTimeout(r,i===0?1200:2500)); const chk=await oldStillActive(); endedState=chk.state; if(![2,3].includes(endedState)){ endedOk=true; break; } }
    result.endedCheck={ok:endedOk,state:endedState};
    if(!endedOk){ result.reason='old activity did not end'; return result; }
    async function buildStrictCreateGroup(group){
      const base=buildBase(group.activityNamePrefix, group.endTime);
      const check=await post('/promotion/simple_platform/check_activity', base);
      const effective=check.info?.effective_center_list || [];
      const q=await post('/promotion/simple_platform/query_goods',{page_size:500,page_num:1,activity_base_info_request:{...base,sub_type_id:2},effective_center_list:effective,skc_list:(group.rows||[]).map(r=>r.skc),is_shelf:1});
      const goods=q.info?.data || q.info || [];
      const built=buildRows(goods, check.info, group.rows||[]);
      const failed=built.missing.length || built.invalid.length || built.add.length!==(group.rows||[]).length;
      return {group:group.group, endTime:group.endTime, activityNamePrefix:group.activityNamePrefix, base, validation:{missing:built.missing, invalid:built.invalid, hardInvalid:built.hardInvalid, addRows:built.add.length, expected:(group.rows||[]).length}, plannedGoods:built.detail, createPayload:{activity_base_info_request:{...base,notify_flag:1,sub_type_id:2}, pricing_type, add_cost_and_stock_info_list:built.add, update_cost_and_stock_info_list:[], delete_cost_and_stock_info_list:[]}, failed};
    }
    result.postEndGroups=[];
    for(const sourceGroup of plan.groups){
      const group=await buildStrictCreateGroup(sourceGroup);
      result.postEndGroups.push(group);
      if(group.failed){
        result.reason='post-end validation failed before recreating split activities';
        return result;
      }
      const packet=await post('/promotion/simple_platform/create_activity', group.createPayload);
      const id=packet.info?.activity_id || packet.info?.id || packet.info?.activityId || packet.info?.data?.activity_id || packet.info?.data?.id;
      const goodsPacket=id ? await post('/promotion/simple_platform/query_activity_goods',{activity_id:id,page_num:1,page_size:1000}) : null;
      const goods=goodsPacket ? (goodsPacket.info?.data || goodsPacket.info || []) : [];
      result.created.push({group:group.group, activityId:id||null, response:{code:packet.code,msg:packet.msg,info:packet.info}, goods:goods.map(g=>({skc:g.skc,supplier:g.sku_supplier_no,price:g.product_act_price,state:g.goods_state}))});
    }
    const createdSkcs=[...new Set(result.created.flatMap(c=>c.goods.map(g=>String(g.skc))))].sort();
    result.after={createdSkcs, expected, allExpectedCovered: expected.every(s=>createdSkcs.includes(s))};
    result.ok=!!result.after.allExpectedCovered;
    return result;
  `,{plan, allRows, expectedSet, execute:args.execute, startDelayMinutes:args.startDelayMinutes});
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  outPath=path.join(args.outDir,`mixed-limited-recreate-${args.execute?'execute':'dry-run'}-${args.storeKey}-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify({createdAt:new Date().toISOString(), planPath:rel(args.plan), storeKey:args.storeKey, identity, ...result}, null, 2),'utf8');
  console.log(JSON.stringify({ok:result.ok, execute:args.execute, out:rel(outPath), validationFailed:result.validationFailed, oldActivity:result.oldSummary?.activity_id, dryRunOnly:result.dryRunOnly||false, ended:result.ended||null, created:result.created?.map(c=>({group:c.group,activityId:c.activityId,goods:c.goods?.length}))||[], after:result.after||null, reason:result.reason||''}, null, 2));
  if(!result.ok) process.exitCode=2;
}catch(error){
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  outPath=path.join(args.outDir,`mixed-limited-recreate-${args.execute?'execute':'dry-run'}-failed-${args.storeKey}-${stamp}.json`);
  await fs.writeFile(outPath, JSON.stringify({createdAt:new Date().toISOString(), planPath:rel(args.plan), storeKey:args.storeKey, execute:args.execute, error:error.message, stack:error.stack}, null, 2),'utf8');
  console.error(JSON.stringify({ok:false, execute:args.execute, out:rel(outPath), error:error.message}, null, 2));
  process.exitCode=1;
}finally{ cdp.close(); }
