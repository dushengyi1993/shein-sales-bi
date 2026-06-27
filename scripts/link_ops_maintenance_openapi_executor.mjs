#!/usr/bin/env node
/**
 * SHEIN OpenAPI link-maintenance executor.
 *
 * Supports dry-run and guarded execute for maintenance actions that are backed
 * by official OpenAPI endpoints: activate_link, retire_link, update_inventory,
 * update_supply_price, update_product_price, update_title, update_images.
 * It never silently writes: execute requires the server-side task state, a
 * dry-run payload hash, safe write gates and the explicit confirm text.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {formatStoreIdentityError, validateStoreIdentity} from '../lib/shein_store_identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'link-ops-maintenance-openapi-executor');
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const STORES_CONFIG = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'stores.json'), 'utf8'));
const STORE_ACCOUNT_TRUTH = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_account_truth.json'), 'utf8'));

const ACTIONS = {
  activate_link: {
    endpoint: '/open-api/goods/modify-skc-shelf',
    readbackKind: 'product',
  },
  retire_link: {
    endpoint: '/open-api/goods/modify-skc-shelf',
    readbackKind: 'product',
  },
  update_inventory: {
    endpoint: '/open-api/stock/change-inventory/v2',
    readbackKind: 'stock',
  },
  update_supply_price: {
    endpoint: '/open-api/goods/update-cost',
    readbackKind: 'product',
  },
  update_product_price: {
    endpoint: '/open-api/openapi-business-backend/product/price/save',
    readbackKind: 'product',
  },
  update_title: {
    endpoint: '/open-api/goods/product/partialEdit',
    readbackKind: 'product',
  },
  update_images: {
    endpoint: '/open-api/goods/product/partialEdit',
    readbackKind: 'product',
  },
  certificate_review: {
    endpoint: '/open-api/goods/get-certificate-rule',
    readbackKind: 'manual',
  },
};
const CERTIFICATE_ALLOWED_ENDPOINTS = new Set([
  '/open-api/goods/get-certificate-rule',
  '/open-api/goods/certificate/get-all-certificate-type-list-v2',
  '/open-api/goods/upload-certificate-file',
  '/open-api/goods/save-or-update-certificate-pool',
  '/open-api/goods/save-or-update-supplier-certificate',
  '/open-api/goods/save-certificate-pool-skc-bind',
  '/open-api/goods-compliance/update-skc-warning-certificate',
]);
const MAINTENANCE_INTENTS = new Set(Object.keys(ACTIONS));

function parseArgs(argv) {
  const args = {config: DEFAULT_CONFIG, taskFile: DEFAULT_TASK_FILE, taskId: '', taskJson: '', mode: 'dry-run', outDir: DEFAULT_OUT_DIR, store: '', confirm: '', dir: '', productCacheDir: path.join(ROOT, 'outputs', 'shein_openapi_products'), quiet: false};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--task-file') args.taskFile = path.resolve(argv[++i]);
    else if (a === '--task-id') args.taskId = String(argv[++i] || '').trim();
    else if (a === '--task-json') args.taskJson = path.resolve(argv[++i]);
    else if (a === '--out-dir') args.outDir = path.resolve(argv[++i]);
    else if (a === '--store') args.store = String(argv[++i] || '').trim().toUpperCase();
    else if (a === '--dir') args.dir = path.resolve(argv[++i]);
    else if (a === '--product-cache-dir') args.productCacheDir = path.resolve(argv[++i]);
    else if (a === '--mode') args.mode = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--dry-run') args.mode = 'dry-run';
    else if (a === '--execute') args.mode = 'execute';
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-id <id> --store DX --dry-run\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-json task.json --store DX --execute --confirm ${SUBMIT_CONFIRM_TEXT}`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['dry-run', 'execute'].includes(args.mode)) throw new Error(`Invalid --mode: ${args.mode}`);
  return args;
}
function asArray(v){ if(v===undefined||v===null) return []; return Array.isArray(v)?v:[v]; }
function safeString(v,max=800){ return String(v??'').replace(/\s+/g,' ').trim().slice(0,max); }
function normalizeStoreKey(v){ return String(v||'').trim().toUpperCase(); }
function rel(file){ return path.relative(ROOT,file).replace(/\\/g,'/'); }
function stableJson(v){ if(v===null||typeof v!=='object') return JSON.stringify(v); if(Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`; return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`; }
function sha256Stable(v){ return crypto.createHash('sha256').update(stableJson(v),'utf8').digest('hex'); }
function compactRef(v){ return String(v||'').toLowerCase().replace(/[\s_\-（）()【】\[\]，,。.;；:：/\\]+/g,''); }
function unique(xs){ return [...new Set(xs.filter(Boolean))]; }
function nowId(){ return new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14); }
function parseNumberFromText(text){ const m=String(text||'').match(/(?:改成|改为|更新为|设置为|设为|到|=|：|:)\s*([0-9]+(?:\.[0-9]{1,2})?)/i) || String(text||'').match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:sar|库存|件|个|台|$)/i); return m?Number(m[1]):NaN; }
function parseNumberForIntent(intent, text){
  const raw=String(text||'');
  const specs={
    update_inventory:[/(?:库存|虚拟库存|inventory|stock).{0,20}?(?:改成|改为|更新为|设置为|设为|到|=|：|:)\s*([0-9]+)/i,/([0-9]+)\s*(?:件|个|台).{0,12}(?:库存|虚拟库存|inventory|stock)/i],
    update_supply_price:[/(?:供货价|成本价|cost price|supply price|cost).{0,24}?(?:改成|改为|更新为|设置为|设为|到|=|：|:)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:sar|SAR).{0,16}(?:供货价|成本价|cost)/i],
    update_product_price:[/(?:售价|原价|销售价|商品价|shop price|product price|price).{0,24}?(?:改成|改为|更新为|设置为|设为|到|=|：|:)\s*([0-9]+(?:\.[0-9]{1,2})?)/i,/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:sar|SAR).{0,16}(?:售价|原价|销售价|商品价|price)/i],
  };
  for(const re of specs[intent]||[]){ const m=raw.match(re); if(m) return Number(m[1]); }
  return parseNumberFromText(raw);
}
function parseTitleFromText(text){ const m=String(text||'').match(/(?:标题|title).{0,16}(?:改成|改为|换成|更新为|改到|=>|：|:)\s*[“"']?(.+?)[”"']?\s*$/i); return m?safeString(m[1],1000):''; }
async function readJson(file){ return JSON.parse(await fs.readFile(file,'utf8')); }
async function writeJson(file,data){ await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file, `${JSON.stringify(data,null,2)}\n`, 'utf8'); }
function normalizeTaskStore(data){ if(Array.isArray(data?.tasks)) return data; if(data?.id) return {version:1,tasks:[data]}; throw new Error('Task JSON must be a task object or {tasks:[...]}'); }
async function loadTask(args){ const source=args.taskJson||args.taskFile; const store=normalizeTaskStore(await readJson(source)); const task=args.taskId?store.tasks.find(t=>String(t?.id||'')===args.taskId):(store.tasks.length===1?store.tasks[0]:null); if(!task) throw new Error(`Task not found: ${args.taskId||'(missing --task-id)'}`); return {source, task, taskStore: store, executionContext: store.executionContext || null}; }
function taskStores(task){ return unique([...(task?.targets?.stores||[]), ...(task?.targets?.targetStores||[]), ...(task?.stores||[]), ...(task?.targetStores||[])]).map(normalizeStoreKey).filter(Boolean); }
function taskProductRefs(task){ return unique([...(task?.targets?.productRefs||[]), ...(task?.productRefs||[]), ...(task?.products||[])]).map(x=>safeString(x,120)).filter(Boolean); }
function taskIntents(task){ return asArray(task?.intents).map(x=>String(x||'').trim()).filter(x=>MAINTENANCE_INTENTS.has(x)); }
function linkRowStore(row){ return normalizeStoreKey(row?.store_key || row?.storeKey); }
function linkRowSkc(row){ return safeString(row?.skc || row?.skcCode || row?.skc_code,120); }
function linkRowSpu(row){ return safeString(row?.spu || row?.spuName || row?.spu_name,120); }
function linkRowStandard(row){ return safeString(row?.standard_goods_sn || row?.standardGoodsSn || row?.product_display_name || row?.productDisplayName || row?.raw_goods_sn || row?.rawGoodsSn,160); }
function linkRowOnShelf(row){ if(row?.is_on_shelf!==undefined) return Boolean(row.is_on_shelf); if(row?.isOnShelf!==undefined) return Boolean(row.isOnShelf); return /已上架|在售|ON_SHELF|on/i.test(String(row?.shelf_status_name||row?.shelfStatusName||row?.visible_shelf_statuses||'')) && !/已下架|待上架|售罄/.test(String(row?.shelf_status_name||'')); }
function rowMatches(row, ref){ const q=compactRef(ref); if(!q) return false; return [linkRowSkc(row), linkRowSpu(row), linkRowStandard(row), row?.raw_goods_sn, row?.rawGoodsSn, row?.supplierCode, row?.supplier_code].map(compactRef).filter(Boolean).some(x=>x===q||x.includes(q)||q.includes(x)); }
function extractRows(payload){ const data=payload?.data&&typeof payload.data==='object'?payload.data:payload; if(Array.isArray(data?.storeLinks)) return data.storeLinks; if(Array.isArray(data?.links)) return data.links; return []; }
async function loadLinkRows(args){ const root=args.dir||path.join(ROOT,'outputs','bi-portal'); const candidates=[path.join(root,'sections','linksData.json'), path.join(root,'data.json')]; const errors=[]; for(const file of candidates){ try{ const j=await readJson(file); const rows=extractRows(j); if(rows.length) return {file, rows}; errors.push(`${rel(file)}:0 rows`);}catch(e){errors.push(`${rel(file)}:${e.message}`);} } return {file:candidates[0], rows:[], error:errors.join('；')}; }
function parseSkuCodes(value){ if(Array.isArray(value)) return value.map(x=>safeString(x,80)).filter(Boolean); if(typeof value==='string'){ try{ const j=JSON.parse(value); if(Array.isArray(j)) return j.map(x=>safeString(x,80)).filter(Boolean); }catch{} return value.split(/[;,\s]+/).map(x=>safeString(x,80)).filter(Boolean); } return []; }
function productRowMatches(row, {skc,spu,standard}){ const refs=[row?.skc,row?.skcName,row?.skc_name,row?.spu,row?.spuName,row?.spu_name,row?.supplierCode,row?.supplier_code,row?.supplier_code,row?.productNameZh,row?.productNameEn].map(compactRef); const qs=[skc,spu,standard].map(compactRef).filter(Boolean); return qs.some(q=>refs.some(x=>x&& (x===q||x.includes(q)||q.includes(x)))); }
async function loadProductRows(store,args={}){ const file=path.join(args.productCacheDir||path.join(ROOT,'outputs','shein_openapi_products'),store,'latest.json'); try{ const j=await readJson(file); return {file, rows:Array.isArray(j.normalizedRows)?j.normalizedRows:[]}; }catch(e){ return {file, rows:[], error:e.message}; } }
async function loadJsonAssetPayloads(task){
  const out=[];
  for(const asset of Array.isArray(task?.assets)?task.assets:[]){
    const mime=String(asset?.mime||'').toLowerCase();
    const relPath=safeString(asset?.storedRelativePath||asset?.path||'',500);
    if(mime!=='application/json' && !/\.json$/i.test(relPath||asset?.originalName||'')) continue;
    if(!relPath) continue;
    const file=path.resolve(ROOT,relPath);
    if(!file.startsWith(ROOT)) continue;
    try{ out.push({assetId:asset.id||'',file:rel(file),json:await readJson(file)}); }catch{}
  }
  return out;
}
function normalizeImageEditPayloadsFromJsonAssets(task, matches, warnings){
  const embedded=[];
  const sources=[];
  for(const value of Array.isArray(task?._jsonAssets)?task._jsonAssets:[]){
    const json=value?.json;
    const candidates=[json?.partialEditPayload,json?.payload,json?.imageEditPayload,json].filter(Boolean);
    for(const item of candidates){
      const payload=item?.partialEditPayload||item;
      if(payload&&typeof payload==='object'&&payload.spu_name&&(payload.image_info||payload.skc_list||payload.site_detail_image_info_list)){
        embedded.push(payload); sources.push(value.file||value.assetId||'json-asset');
      } else if(payload&&typeof payload==='object'&&(payload.image_info||payload.skc_list||payload.site_detail_image_info_list)){
        for(const m of matches){ if(m.spu) { embedded.push({spu_name:m.spu,...payload}); sources.push(value.file||value.assetId||'json-asset'); } }
      }
    }
  }
  const direct=task?.imageEditPayload||task?.partialEditPayload||task?.targets?.imageEditPayload;
  if(direct&&typeof direct==='object'){
    if(direct.spu_name&&(direct.image_info||direct.skc_list||direct.site_detail_image_info_list)) { embedded.push(direct); sources.push('task.imageEditPayload'); }
    else if(direct.image_info||direct.skc_list||direct.site_detail_image_info_list) for(const m of matches){ if(m.spu) { embedded.push({spu_name:m.spu,...direct}); sources.push('task.imageEditPayload'); } }
  }
  if(embedded.length) warnings.push(`换图将使用已提供的 SHEIN partialEdit 图片 JSON：${unique(sources).join('、')}；执行前需人工确认该 JSON 不会清空其他图片层级。`);
  const seen=new Set();
  return embedded.filter(payload=>{ const key=sha256Stable(payload); if(seen.has(key)) return false; seen.add(key); return true; });
}
async function loadClient(args){ const config=await readJson(args.config); const stores=Array.isArray(config.stores)?config.stores:Object.entries(config.stores||{}).map(([storeKey,v])=>({storeKey,...v})); const store=stores.find(s=>normalizeStoreKey(s?.storeKey||s?.key||s?.store)===normalizeStoreKey(args.store)); if(!store?.openKeyId||!store?.secretKey) throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`); return {config, store, client:new SheinOpenApiClient({baseUrl:config.apiBaseUrls?.prodSemiManaged||SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, openKeyId:store.openKeyId, secretKey:store.secretKey})}; }
function compactCallResult(name,pathText,method,response){ return {name,path:pathText,method,httpStatus:response.status??response.httpStatus??null,code:response.data?.code??response.code??null,msg:safeString(response.data?.msg??response.msg??'',300),traceId:response.data?.traceId??response.traceId??null}; }
async function callOpenApi(client, {name, path:pathText, method='POST', body, query}){ const response=await client.request(pathText,{method,body,query,headers:{language:'zh-cn'}}); return {...compactCallResult(name,pathText,method,response), data:response.data}; }
function summarizeSiteList(data){ const rows=[]; const q=[data]; const seen=new Set(); while(q.length&&rows.length<300){ const cur=q.shift(); if(!cur||typeof cur!=='object'||seen.has(cur)) continue; seen.add(cur); if(Array.isArray(cur)){ q.push(...cur); continue; } const site=safeString(cur.siteAbbr||cur.site_abbr||cur.site||cur.subSite||cur.sub_site||cur.siteCode||cur.site_code,80); const currency=safeString(cur.currency||cur.currencyCode||cur.currency_code,20).toUpperCase(); if(site) rows.push({siteAbbr:site,currency}); q.push(...Object.values(cur)); } return rows; }
async function getDefaultSite(client,calls,warnings){ try{ const r=await callOpenApi(client,{name:'query-site-list',path:'/open-api/goods/query-site-list',body:{}}); calls.push(compactCallResult(r.name,r.path,r.method,{status:r.httpStatus,data:r.data})); const sites=summarizeSiteList(r.data); const sa=sites.find(x=>String(x.siteAbbr).toLowerCase()==='shein-sa')||sites.find(x=>String(x.currency).toUpperCase()==='SAR')||sites[0]; if(!sa) warnings.push('站点列表为空，默认使用 shein-sa/SAR 但执行前必须人工复核。'); return {site:sa?.siteAbbr||'shein-sa', currency:sa?.currency||'SAR', sites:sites.slice(0,20)}; }catch(e){ warnings.push(`站点列表探针失败：${safeString(e.message||e)}；默认使用 shein-sa/SAR。`); return {site:'shein-sa',currency:'SAR',sites:[]}; } }
function normalizeCertificatePayloadsFromJsonAssets(task, warnings){
  const out=[];
  const sources=[];
  const pushPayload=(payload, source)=>{
    if(!payload||typeof payload!=='object') return;
    const endpoint=safeString(payload.endpoint||payload.path||payload.openPath||'',200);
    const body=payload.body||payload.payload||payload.requestBody||null;
    if(!endpoint||!body||typeof body!=='object') return;
    if(!CERTIFICATE_ALLOWED_ENDPOINTS.has(endpoint)) { warnings.push(`证书 payload endpoint 不在允许列表，已忽略：${endpoint}`); return; }
    out.push({endpoint,body,label:safeString(payload.label||payload.operation||'certificate_payload',120)});
    sources.push(source||'json');
  };
  for(const value of Array.isArray(task?._jsonAssets)?task._jsonAssets:[]){
    const json=value?.json;
    for(const payload of asArray(json?.certificatePayloads||json?.certificate_payloads)) pushPayload(payload,value.file||value.assetId||'json-asset');
    pushPayload(json?.certificatePayload||json?.certificate_payload,value.file||value.assetId||'json-asset');
    if(json?.endpoint&&json?.body) pushPayload(json,value.file||value.assetId||'json-asset');
  }
  for(const payload of asArray(task?.certificatePayloads||task?.targets?.certificatePayloads)) pushPayload(payload,'task.certificatePayloads');
  pushPayload(task?.certificatePayload||task?.targets?.certificatePayload,'task.certificatePayload');
  if(out.length) warnings.push(`证书动作将使用已提供的官方 OpenAPI JSON payload：${unique(sources).join('、')}；提交后默认需要人工核销审核状态。`);
  return out;
}
function resolveTargets({task, store, linkRows, productRows}){ const refs=taskProductRefs(task); const matches=[]; const missing=[]; for(const ref of refs){ const candidates=linkRows.filter(r=>linkRowStore(r)===store&&rowMatches(r,ref)).sort((a,b)=>Number(linkRowOnShelf(b))-Number(linkRowOnShelf(a))).slice(0,20); if(!candidates.length){ missing.push(ref); continue; } for(const row of candidates){ const skc=linkRowSkc(row), spu=linkRowSpu(row), standard=linkRowStandard(row); const prod=productRows.find(p=>productRowMatches(p,{skc,spu,standard}))||{}; matches.push({ref, storeKey:store, skc, spu, standardGoodsSn:standard, isOnShelf:linkRowOnShelf(row), skuCodes:parseSkuCodes(prod.skuCodes||prod.skuCodeList||prod.sku_code_list||prod.skuCode), supplierCode:safeString(prod.supplierCode||prod.supplier_code||standard,160), costSar:Number(prod.costSar||row.original_supply_price_range_sar||0)||null, sheinUsableInventory:Number(prod.sheinUsableInventory||row.visible_usable_inventory||row.visible_inventory_quantity||0)||0, productRowFound:Boolean(Object.keys(prod).length)}); }
  }
  const uniq=[]; const seen=new Set(); for(const m of matches){ const key=`${m.storeKey}|${m.skc}|${m.standardGoodsSn}`; if(seen.has(key)) continue; seen.add(key); uniq.push(m); }
  return {refs, matches:uniq, missing}; }
function buildPayloads({task,intents,matches,siteInfo,blockers,warnings,imageEditPayloads=[],certificatePayloads=[]}){
  const command=String(task?.command||task?.text||''); const out=[];
  for(const intent of intents){
    const endpoint=ACTIONS[intent].endpoint;
    if(intent==='activate_link'){
      const inactive=matches.filter(m=>m.isOnShelf!==true);
      if(!inactive.length) blockers.push('上架任务没有匹配到待上架/已下架/非在售链接。');
      out.push({operation:intent, endpoint, body:{skc_site_info_list:inactive.map(m=>({shelf_state:1, site_list:[siteInfo.site], skc_name:m.skc}))}, targetLinks:inactive});
    } else if(intent==='retire_link'){
      const active=matches.filter(m=>m.isOnShelf!==false);
      if(!active.length) blockers.push('下架任务没有匹配到已上架链接。');
      out.push({operation:intent, endpoint, body:{skc_site_info_list:active.map(m=>({shelf_state:2, site_list:[siteInfo.site], skc_name:m.skc}))}, targetLinks:active});
    } else if(intent==='update_inventory'){
      const qty=parseNumberForIntent(intent, command); if(!Number.isFinite(qty)||qty<0) blockers.push('改库存任务缺少目标库存数量，例如“库存改成 100”。');
      const items=matches.flatMap(m=>m.skuCodes.map(sku=>({idempotencyKey:`biops-${task.id||nowId()}-${m.storeKey}-${sku}-${Math.max(0,Math.trunc(qty||0))}`.slice(0,120), skuCode:sku, invType:'VI', changeType:'OVERWRITE', changeQuantity:Math.max(0,Math.trunc(qty||0)), changeReason:'BI Ops guarded inventory update'})));
      if(!items.length) blockers.push('改库存任务未解析到 SKU code，无法构建库存更新 payload。');
      out.push({operation:intent, endpoint, body:{updateSkuInventoryQuantityRequests:items}, targetLinks:matches});
    } else if(intent==='update_supply_price'){
      const price=parseNumberForIntent(intent, command); if(!Number.isFinite(price)||price<=0) blockers.push('改供货价任务缺少目标供货价，例如“供货价改成 80 SAR”。');
      const items=matches.filter(m=>m.skuCodes.length).map(m=>({skc_name:m.skc, change_price_reason_flag:'4', change_remark:'BI Ops guarded cost update', sku_info_list:m.skuCodes.map(sku=>({sku_code:sku,cost:Number(price.toFixed(2)),currency:'SAR'}))}));
      if(!items.length) blockers.push('改供货价任务未解析到 SKU code，无法构建成本价 payload。');
      out.push({operation:intent, endpoint, body:{spu_name:matches[0]?.spu||'', skc_info_list:items}, targetLinks:matches});
    } else if(intent==='update_product_price'){
      const price=parseNumberForIntent(intent, command); if(!Number.isFinite(price)||price<=0) blockers.push('改商品售价任务缺少目标售价，例如“售价改成 99 SAR”。');
      warnings.push('商品售价 API 同时写入 shopPrice 与 specialPrice，避免 SHEIN 将未传 specialPrice 解析为 0；真实执行前仍需人工复核当前活动价影响。');
      const productPriceList=matches.flatMap(m=>m.skuCodes.map(sku=>({productCode:sku,currencyCode:siteInfo.currency||'SAR',shopPrice:Number(price.toFixed(2)),specialPrice:Number(price.toFixed(2)),site:siteInfo.site,riseReason:'4'})));
      if(!productPriceList.length) blockers.push('改商品售价任务未解析到 SKU code，无法构建售价 payload。');
      out.push({operation:intent, endpoint, body:{productPriceList}, targetLinks:matches});
    } else if(intent==='update_title'){
      const title=parseTitleFromText(command); if(!title) blockers.push('改标题任务缺少新标题，例如“标题改成 XXX”。');
      const spuGroups=[...new Map(matches.map(m=>[m.spu,m])).values()].filter(m=>m.spu);
      if(!spuGroups.length) blockers.push('改标题任务未解析到 SPU，无法构建 partialEdit payload。');
      for(const m of spuGroups){ out.push({operation:intent, endpoint, body:{spu_name:m.spu, multi_language_name_list:[{language:'zh-cn', name:title}]}, targetLinks:[m]}); }
    } else if(intent==='update_images'){
      const imagePlans=Array.isArray(imageEditPayloads)?imageEditPayloads:[];
      if(!imagePlans.length) blockers.push('换图任务缺少完整 SHEIN partialEdit 图片 JSON：需提供 spu_name + image_info/skc_list/site_detail_image_info_list，或先通过图片上传/外链转换取得 SHEIN 图片 URL 后再提交。');
      for(const body of imagePlans){ out.push({operation:intent, endpoint, body, targetLinks:matches}); }
      if(!imagePlans.length) out.push({operation:intent, endpoint, body:{}, targetLinks:matches});
    } else if(intent==='certificate_review'){
      const certPlans=Array.isArray(certificatePayloads)?certificatePayloads:[];
      if(!certPlans.length) blockers.push('证书/资质任务缺少官方 OpenAPI JSON payload：需提供 certificatePayloads[{endpoint,body}]，endpoint 必须在证书允许列表内。');
      for(const plan of certPlans){ out.push({operation:intent, endpoint:plan.endpoint, body:plan.body, targetLinks:matches, label:plan.label}); }
      if(!certPlans.length) out.push({operation:intent, endpoint, body:{}, targetLinks:matches});
    }
  }
  for(const p of out){ if(!Object.keys(p.body||{}).length) warnings.push(`${p.operation} 未生成可提交 payload。`); }
  return out;
}
async function readbackProduct(client, matches, calls){ const response=await client.request('/open-api/openapi-business-backend/product/query',{method:'POST',body:{pageNum:1,pageSize:100},headers:{language:'zh-cn'}}); calls.push(compactCallResult('product-query-readback','/open-api/openapi-business-backend/product/query','POST',response)); const rows=[]; const q=[response.data]; const seen=new Set(); while(q.length&&rows.length<500){ const cur=q.shift(); if(!cur||typeof cur!=='object'||seen.has(cur)) continue; seen.add(cur); if(Array.isArray(cur)){q.push(...cur); continue;} if(cur.skcName||cur.skc_name||cur.spuName||cur.spu_name||cur.supplierCode||cur.supplier_code||cur.skuCodeList||cur.skuCodes) rows.push(cur); q.push(...Object.values(cur)); } const matched=matches.filter(m=>rows.some(r=>productRowMatches(r,{skc:m.skc,spu:m.spu,standard:m.standardGoodsSn}))); return {ok:matched.length>0, status:matched.length?'matched_product_query':'not_matched_product_query', scannedRows:rows.length, matchedRows:matched.slice(0,20), calls}; }
async function readbackStock(client, matches, calls){ const skuCodes=unique(matches.flatMap(m=>m.skuCodes)); if(!skuCodes.length) return {ok:false,status:'missing_sku_codes',matchedRows:[],calls}; const response=await client.request('/open-api/stock/stock-query',{method:'POST',body:{skuCodes},headers:{language:'zh-cn'}}); calls.push(compactCallResult('stock-query-readback','/open-api/stock/stock-query','POST',response)); const ok=String(response.data?.code)==='0'; return {ok, status:ok?'matched_stock_query':'stock_query_failed', skuCodes:skuCodes.slice(0,100), matchedRows:ok?matches.slice(0,20):[], calls}; }
async function readbackForIntents(client, intents, matches, calls){
  const groups=[];
  if(intents.includes('update_inventory')) groups.push(await readbackStock(client,matches,calls));
  const productReadbackIntents=intents.filter(x=>!['update_inventory','certificate_review'].includes(x));
  if(productReadbackIntents.length) groups.push(await readbackProduct(client,matches,calls));
  if(intents.includes('certificate_review')) groups.push({ok:false,status:'certificate_submitted_manual_review_required',matchedRows:[],calls,warnings:['证书/资质提交后需人工确认平台审核状态，不能自动判成功。']});
  if(!groups.length) return {ok:false,status:'not_run',matchedRows:[],calls};
  const ok=groups.every(g=>g.ok);
  const matchedRows=groups.flatMap(g=>Array.isArray(g.matchedRows)?g.matchedRows:[]);
  return {ok,status:groups.map(g=>g.status).join('+'),matchedRows,groups,calls};
}
async function main(){
  const args=parseArgs(process.argv.slice(2)); const startedAt=new Date().toISOString(); const runId=`lmo_${nowId()}_${crypto.randomBytes(4).toString('hex')}`; const {task, executionContext}=await loadTask(args); const store=args.store||taskStores(task)[0]; if(!store) throw new Error('Missing --store / task store'); const intents=taskIntents(task); const blockers=[]; const warnings=[]; const calls=[];
  if(!intents.length) blockers.push('任务不包含维护写动作。');
  const {client, store: configuredStore}=await loadClient({...args, store});
  const storeInfo=await callOpenApi(client,{name:'store-info',path:'/open-api/openapi-business-backend/query-store-info',body:{}}).catch(e=>({error:e}));
  if(storeInfo.error) warnings.push(`店铺信息探针失败：${safeString(storeInfo.error.message||storeInfo.error)}`); else calls.push(compactCallResult(storeInfo.name,storeInfo.path,storeInfo.method,{status:storeInfo.httpStatus,data:storeInfo.data}));
  const truth=STORE_ACCOUNT_TRUTH.stores?.[store];
  if(truth && storeInfo.data){ const identity=validateStoreIdentity({store:configuredStore, truth, storageIdentity: {storeTitle: storeInfo.data?.info?.storeTitle || storeInfo.data?.info?.shopName || '', mallCode: storeInfo.data?.info?.mallCode || ''}, href:'openapi:/open-api/openapi-business-backend/query-store-info'}); if(!identity.ok) blockers.push(formatStoreIdentityError(identity)); }
  const siteInfo=await getDefaultSite(client,calls,warnings);
  const linkLoad=await loadLinkRows(args); if(linkLoad.error) blockers.push(`无法读取 BI 链接快照：${linkLoad.error}`);
  const productLoad=await loadProductRows(store,args); if(productLoad.error) warnings.push(`OpenAPI 商品缓存不可读，将只用链接快照：${productLoad.error}`);
  const jsonAssets=await loadJsonAssetPayloads(task);
  const taskWithJsonAssets={...task,_jsonAssets:jsonAssets};
  const resolved=resolveTargets({task, store, linkRows:linkLoad.rows||[], productRows:productLoad.rows||[]});
  if(resolved.missing.length) blockers.push(`未定位到目标货号/SKC：${resolved.missing.join('、')}`);
  if(!resolved.matches.length) blockers.push('没有可执行目标链接。');
  const imageEditPayloads=normalizeImageEditPayloadsFromJsonAssets(taskWithJsonAssets,resolved.matches,warnings);
  const certificatePayloads=normalizeCertificatePayloadsFromJsonAssets(taskWithJsonAssets,warnings);
  const payloads=buildPayloads({task:taskWithJsonAssets,intents,matches:resolved.matches,siteInfo,blockers,warnings,imageEditPayloads,certificatePayloads});
  const submitPlan={storeKey:store,intents,payloads:payloads.map(p=>({operation:p.operation,endpoint:p.endpoint,body:p.body,targetSkcs:p.targetLinks.map(x=>x.skc).filter(Boolean)}))};
  const payloadHash=payloads.some(p=>Object.keys(p.body||{}).length)?sha256Stable(submitPlan):'';
  if(args.mode==='execute'){
    const expected=safeString(executionContext?.expectedPayloadHash||executionContext?.request?.expectedPayloadHash||executionContext?.request?.payloadHash||'',120);
    if(args.confirm!==SUBMIT_CONFIRM_TEXT) blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    if(!expected) blockers.push('真实提交缺少 dry-run 锁定的 payload hash。');
    else if(!payloadHash||payloadHash!==expected) blockers.push(`真实提交 payload hash 与 dry-run 锁定值不一致：expected=${expected||'missing'} actual=${payloadHash||'missing'}`);
  }
  let submitResults=[]; let actualWriteSubmitted=false;
  if(args.mode==='execute' && blockers.length===0){
    for(const p of payloads){ const response=await client.request(p.endpoint,{method:'POST',body:p.body,headers:{language:'zh-cn'}}); const compact=compactCallResult(p.operation,p.endpoint,'POST',response); calls.push(compact); submitResults.push({...compact, operation:p.operation}); if(String(response.data?.code)!=='0') blockers.push(`${p.operation} 返回失败：${safeString(response.data?.msg||response.data?.code||'未知错误')}`); }
    actualWriteSubmitted=submitResults.some(r=>String(r.code)==='0');
  }
  const readbackCalls=[]; let readback={ok:false,status:args.mode==='execute'?'not_run':'planned_not_run',calls:readbackCalls};
  if(actualWriteSubmitted){ readback=await readbackForIntents(client,intents,resolved.matches,readbackCalls); }
  const state=args.mode==='execute' ? (actualWriteSubmitted?'submitted':'blocked') : (blockers.length?'blocked':'ready_for_submit');
  const output={ok:blockers.length===0, runId, mode:args.mode, adapterKind:'link_maintenance_openapi_executor', state, startedAt, endedAt:new Date().toISOString(), storeKey:store, task:{id:task.id||'',status:task.status||'',intents,productRefs:taskProductRefs(task)}, payload:{found:Boolean(payloadHash), payloadHash, payloadHashAlgorithm:payloadHash?'sha256-stable-json-v1':'', summary:{operations:payloads.map(p=>p.operation), endpoints:payloads.map(p=>p.endpoint), targetCount:resolved.matches.length, skuCount:unique(resolved.matches.flatMap(m=>m.skuCodes)).length}, submitPlan}, adapterEvidence:{realSubmit:actualWriteSubmitted, canSilentWrite:false, matchedLinksCount:resolved.matches.length, matchedLinks:resolved.matches.slice(0,80), linkSnapshotFile:linkLoad.file?rel(linkLoad.file):'', productCacheFile:productLoad.file?rel(productLoad.file):'', siteInfo, calls}, publishResult: actualWriteSubmitted ? {code:'0', msg:'submitted', traceId:submitResults.map(x=>x.traceId).filter(Boolean).join(',')||null, operations:submitResults} : null, readbackFingerprint:{taskId:task.id||'', intents, targetStores:[store], matchedSkcs:resolved.matches.map(m=>m.skc).filter(Boolean), matchedSkuCodes:unique(resolved.matches.flatMap(m=>m.skuCodes)), payloadHash, readbackStatus:readback.status}, readback, blockers, warnings, safety:{canSilentWrite:false, executeRequiresConfirm:SUBMIT_CONFIRM_TEXT, dryRunDoesNotCallBusinessWrite:args.mode!=='execute', note:'维护写真实提交必须由 BI 服务端权限、白名单、payload hash 和确认文本共同放行。'}};
  if(actualWriteSubmitted && !readback.ok){ output.ok=false; output.state='submitted'; output.blockers=[]; output.warnings.push('写接口返回成功但强回读未确认，任务必须锁定等待人工核销。'); }
  const outPath=path.join(args.outDir,`${runId}.local.json`); await writeJson(outPath,output); output.savedTo=rel(outPath); if(!args.quiet) console.log(JSON.stringify(output,null,2));
}

main().catch(err=>{ console.error(err?.stack||err?.message||String(err)); process.exit(1); });
