#!/usr/bin/env node
/**
 * SHEIN OpenAPI link-maintenance executor.
 *
 * Supports dry-run and guarded execute for maintenance actions that are backed
 * by official OpenAPI endpoints: activate_link, retire_link, update_inventory,
 * update_supply_price, update_product_price, update_title, update_images.
 * It never silently writes: execute requires the server-side task state, a
 * dry-run payload hash, safe write gates and the explicit confirm text.
 *
 * Daily local Windows/Codex usage must not call real SHEIN OpenAPI; run real
 * maintenance writes only inside shein-bi-tencent/cloud runtime or fake tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {selectVirtualInventoryWarehouseCode} from '../lib/shein_inventory_warehouse.mjs';
import {normalizeSheinSkc, sameSheinSkc} from '../lib/shein_product_identifiers.mjs';
import {
  createLoopbackTestWebhookWriteGuard,
  runSheinWebhookExternalWriteGuarded,
} from '../lib/shein_webhook_external_write_guard.mjs';
import {
  formatStoreIdentityError,
  openApiIdentityToStorageIdentity,
  storeIdentityMatchesMerchantOnly,
  validateStoreIdentity,
} from '../lib/shein_store_identity.mjs';

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
  const args = {config: DEFAULT_CONFIG, taskFile: DEFAULT_TASK_FILE, taskId: '', taskJson: '', mode: 'dry-run', outDir: DEFAULT_OUT_DIR, store: '', confirm: '', dir: '', productCacheDir: process.env.SHEIN_OPENAPI_PRODUCT_CACHE_DIR || path.join(ROOT, 'outputs', 'shein_openapi_products'), quiet: false};
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
      console.log(`Usage:\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-id <id> --store DX --dry-run\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-json task.json --store DX --execute --confirm ${SUBMIT_CONFIRM_TEXT}\n\nLocal boundary:\n  do not run real execute from the local Windows/Codex machine; use the cloud BI executor instead.`);
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
function structuredTaskParameters(task){
  const direct=task?.parameters&&typeof task.parameters==='object'&&!Array.isArray(task.parameters)?task.parameters:{};
  const planned=task?.planning?.parameters&&typeof task.planning.parameters==='object'&&!Array.isArray(task.planning.parameters)
    ?task.planning.parameters:{};
  return {...direct,...planned};
}
function numberForTask(intent,task,command){
  const parameters=structuredTaskParameters(task);
  const key={update_inventory:'inventory',update_supply_price:'supplyPrice',update_product_price:'productPrice'}[intent];
  if(key&&parameters[key]!==undefined&&parameters[key]!==null&&parameters[key]!==''){
    const value=Number(parameters[key]);
    return Number.isFinite(value)?value:NaN;
  }
  return parseNumberForIntent(intent,command);
}
function stripTitleInstructionTail(value){
  let title=String(value||'').replace(/\s+/g,' ').trim();
  if(!title) return '';
  const quotePairs={'“':'”','"':'"',"'":"'","‘":"’"};
  const first = title[0];
  if(quotePairs[first]){
    const end = title.indexOf(quotePairs[first], 1);
    if(end > 0) title = title.slice(1, end).trim();
  }
  const instructionBoundary = title.search(/[。；;,，]\s*(?:并\s*)?(?:换图|更换图片|更新图片|图片|图包|素材|细节图|详情图|轮播图|主图|封面|方形图|SKU图|sku图|色块图|参数图|卖点图|场景图|证书|资质|库存|供货价|成本价|售价|价格|上架|下架|上下架|然后|同时|另外|再|其余|其他|如果|用这个|使用本任务|用本任务)/i);
  if(instructionBoundary >= 0) title = title.slice(0, instructionBoundary).trim();
  title = title.replace(/[，,；;。]\s*$/g,'').replace(/^[“"']+|[”"']+$/g,'').trim();
  return title;
}
function parseTitleFromText(text){
  const raw=String(text||'');
  const marker=/(?:标题|title).{0,16}?(?:改成|改为|换成|更新为|改到|=>|：|:)[：:]?\s*/ig;
  let match,last=null;
  while((match=marker.exec(raw))) {
    const prefix = raw.slice(Math.max(0, match.index - 12), match.index);
    if (/(?:阿文|阿拉伯文|arabic\s*|ar\s*)$/i.test(prefix)) continue;
    last=match;
  }
  if(!last) return '';
  return safeString(stripTitleInstructionTail(raw.slice(last.index + last[0].length)),1000);
}
function languageForTitle(title){ return /[\u0600-\u06FF]/.test(String(title||'')) ? 'ar' : 'en'; }
function parseTitleArFromText(text){
  const raw=String(text||'');
  const arMarker=/(?:阿文标题|ar标题|arabic title|阿拉伯文标题)[：:]\s*/i;
  const m=raw.match(arMarker);
  if(!m) return '';
  let rest=raw.slice(m.index+m[0].length);
  const end=rest.search(/[。；;，,\n]/);
  if(end>0) rest=rest.slice(0,end);
  return safeString(stripTitleInstructionTail(rest),1000);
}
function parseAttributeOverrides(task){
  const list=asArray(task?.targets?.attributeOverrides||task?.attributeOverrides||task?.targets?.productAttributeList||task?.productAttributeList);
  return list.filter(x=>x&&typeof x==='object'&&x.attribute_id);
}
function ensureSquareImageSortGlobal(payload){
  for(const skc of asArray(payload?.skc_list||payload?.skcList)){
    const info=skc?.image_info||skc?.imageInfo;
    const rows=asArray(info?.image_info_list||info?.imageInfoList);
    if(!rows.length) continue;
    const maxSort=Math.max(0,...rows.map(r=>Number(r?.image_sort??r?.imageSort??0)));
    const sortCounts={};
    for(const row of rows){ const s=Number(row?.image_sort??row?.imageSort??0); sortCounts[s]=(sortCounts[s]||0)+1; }
    for(const row of rows){
      const t=Number(row?.image_type??row?.imageType??0);
      const s=Number(row?.image_sort??row?.imageSort??0);
      if(t===5 && sortCounts[s]>1){
        row.image_sort=maxSort+1;
        sortCounts[s]--; sortCounts[maxSort+1]=1;
      }
    }
  }
}
async function readJson(file){ return JSON.parse(await fs.readFile(file,'utf8')); }
async function writeJson(file,data){ await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file, `${JSON.stringify(data,null,2)}\n`, 'utf8'); }
function normalizeTaskStore(data){ if(Array.isArray(data?.tasks)) return data; if(data?.id) return {version:1,tasks:[data]}; throw new Error('Task JSON must be a task object or {tasks:[...]}'); }
async function loadTask(args){ const source=args.taskJson||args.taskFile; const store=normalizeTaskStore(await readJson(source)); const task=args.taskId?store.tasks.find(t=>String(t?.id||'')===args.taskId):(store.tasks.length===1?store.tasks[0]:null); if(!task) throw new Error(`Task not found: ${args.taskId||'(missing --task-id)'}`); return {source, task, taskStore: store, executionContext: store.executionContext || null}; }
function taskStores(task){ return unique([...(task?.targets?.stores||[]), ...(task?.targets?.targetStores||[]), ...(task?.stores||[]), ...(task?.targetStores||[])]).map(normalizeStoreKey).filter(Boolean); }
function taskPublishedSkcRefs(task){
  const rows=[];
  const executors=[
    ...asArray(task?.execution?.openApiProductExecutors),
    task?.execution?.hlOpenApiExecutor,
    task?.openApiProductExecutor,
  ].filter(Boolean);
  for(const executor of executors){
    rows.push(...asArray(executor?.readbackFingerprint?.publishSkcNames));
    rows.push(...asArray(executor?.publishResult?.info?.skc_list || executor?.publishResult?.info?.skcList)
      .map(item=>item?.skc_name || item?.skcName));
  }
  rows.push(...asArray(task?.readbackFingerprint?.publishSkcNames));
  rows.push(...asArray(task?.publishResult?.info?.skc_list || task?.publishResult?.info?.skcList)
    .map(item=>item?.skc_name || item?.skcName));
  return unique(rows.map(normalizeSheinSkc).filter(Boolean));
}
function taskProductRefs(task){
  const explicit=unique([...(task?.targets?.productRefs||[]), ...(task?.productRefs||[]), ...(task?.products||[])]).map(x=>safeString(x,120)).filter(Boolean);
  const published=taskPublishedSkcRefs(task);
  return published.length ? published : explicit;
}
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
function productRowMatches(row, {skc,spu,standard}){ const refs=[row?.skc,row?.skcName,row?.skc_name,row?.spu,row?.spuName,row?.spu_name,row?.supplierCode,row?.supplier_code,row?.supplier_code,row?.productNameAr,row?.productNameEn].map(compactRef); const qs=[skc,spu,standard].map(compactRef).filter(Boolean); return qs.some(q=>refs.some(x=>x&& (x===q||x.includes(q)||q.includes(x)))); }
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

function resolveApprovedImageBindingIdentity(task, store, missingRefs, warnings){
  const binding=task?.publishAssetBinding;
  const payload=task?.imageEditPayload||task?.partialEditPayload||task?.targets?.imageEditPayload;
  if(!binding || binding.kind!=='update_images' || binding.sourceApproved!==true) return {matches:[],unresolved:missingRefs};
  if(normalizeStoreKey(binding.targetStore)!==normalizeStoreKey(store)) return {matches:[],unresolved:missingRefs};
  if(!/^[a-f0-9]{64}$/i.test(String(binding.bindingFingerprint||''))) return {matches:[],unresolved:missingRefs};
  if(!payload || typeof payload!=='object') return {matches:[],unresolved:missingRefs};
  const spu=safeString(payload.spu_name||payload.spuName,120);
  if(!/^[a-z]\d{10,}$/i.test(spu) || normalizeSheinSkc(spu)) return {matches:[],unresolved:missingRefs};
  const rows=asArray(payload.skc_list||payload.skcList);
  const matches=[];
  const resolvedRefs=new Set();
  for(const row of rows){
    const skc=normalizeSheinSkc(row?.skc_name||row?.skcName);
    if(!skc) continue;
    const skuCodes=unique(asArray(row?.sku_list||row?.skuList)
      .map(sku=>safeString(sku?.sku_code||sku?.skuCode,80))
      .filter(Boolean));
    matches.push({
      storeKey:store,
      ref:skc,
      skc,
      spu:spu.toLowerCase(),
      standardGoodsSn:safeString(task?.targets?.standardGoodsSn||'',160),
      skuCodes,
      onShelf:false,
      sheinUsableInventory:0,
      productRowFound:true,
      resolvedFrom:'task_approved_image_identity',
    });
    for(const ref of missingRefs){
      if(sameSheinSkc(ref,skc) || compactRef(ref)===compactRef(spu)) resolvedRefs.add(String(ref));
    }
  }
  if(matches.length){
    warnings.push(`换图目标使用同一任务已审核绑定的明确 SPU/SKC 身份；未回退旧链接快照，真实提交仍需 payload hash 与确认门禁。`);
  }
  return {matches,unresolved:missingRefs.filter(ref=>!resolvedRefs.has(String(ref)))};
}

function collectLiveSkcRows(payload){
  const out=[];
  const seen=new Set();
  const walk=(value, context={})=>{
    if(!value || typeof value!=='object' || seen.has(value)) return;
    seen.add(value);
    if(Array.isArray(value)){ for(const item of value) walk(item,context); return; }
    const next={
      spu:safeString(value.spuName||value.spu_name||value.spu||context.spu,120),
      supplierCode:safeString(value.supplierCode||value.supplier_code||context.supplierCode,160),
    };
    const skc=safeString(value.skcName||value.skc_name||value.skc,120);
    if(skc){
      const skuCodes=unique([
        ...parseSkuCodes(value.skuCodeList||value.sku_code_list||value.skuCodes||value.sku_codes),
        ...asArray(value.skuList||value.sku_list).map(row=>safeString(row?.skuCode||row?.sku_code,80)).filter(Boolean),
      ]);
      out.push({skc,spu:next.spu,supplierCode:next.supplierCode,skuCodes});
    }
    for(const child of Object.values(value)) walk(child,next);
  };
  walk(payload,{});
  const uniqueRows=[];
  const keys=new Set();
  for(const row of out){
    const key=`${normalizeSheinSkc(row.skc)||compactRef(row.skc)}|${compactRef(row.spu)}`;
    if(keys.has(key)) continue;
    keys.add(key);
    uniqueRows.push(row);
  }
  return uniqueRows;
}

async function resolveMissingExactSkcsFromOpenApi(client, store, missingRefs, calls, warnings){
  const matches=[];
  const unresolved=[];
  for(const rawRef of missingRefs){
    const ref=normalizeSheinSkc(rawRef);
    if(!ref){ unresolved.push(rawRef); continue; }
    try{
      const response=await client.request('/open-api/goods/searchProduct',{
        method:'POST',
        body:{pageNum:1,pageSize:10,skcNameList:[ref],languageList:['en','ar']},
        headers:{language:'en'},
      });
      calls.push(compactCallResult(`search-product-exact-skc-${ref}`,'/open-api/goods/searchProduct','POST',response));
      if(!response.ok || String(response.data?.code)!=='0'){
        unresolved.push(rawRef);
        continue;
      }
      const exact=collectLiveSkcRows(response.data).filter(row=>sameSheinSkc(row.skc,ref));
      if(exact.length!==1 || !exact[0].spu){
        warnings.push(`${store} 实时精确 SKC 定位 ${rawRef} 返回 ${exact.length} 条有效候选；必须唯一且包含 SPU，当前不自动选择。`);
        unresolved.push(rawRef);
        continue;
      }
      const row=exact[0];
      matches.push({
        ref:rawRef,
        storeKey:store,
        skc:normalizeSheinSkc(row.skc)||safeString(row.skc,120),
        spu:safeString(row.spu,120),
        standardGoodsSn:safeString(row.supplierCode,160),
        isOnShelf:null,
        skuCodes:row.skuCodes,
        supplierCode:safeString(row.supplierCode,160),
        costSar:null,
        sheinUsableInventory:0,
        productRowFound:true,
        resolvedFrom:'openapi_exact_skc',
      });
    }catch(error){
      calls.push({name:`search-product-exact-skc-${ref}`,path:'/open-api/goods/searchProduct',method:'POST',httpStatus:null,code:null,msg:safeString(error?.message||error,300),traceId:null});
      unresolved.push(rawRef);
    }
  }
  return {matches,unresolved};
}

function canonicalizeImagePlanTargets(plan, matches){
  const body=structuredClone(plan);
  const targetSpu=safeString(body?.spu_name||body?.spuName,120);
  const group=matches.filter(m=>!targetSpu || compactRef(m.spu)===compactRef(targetSpu));
  if(group.length && targetSpu) body.spu_name=group[0].spu;
  for(const skcRow of asArray(body?.skc_list||body?.skcList)){
    const requested=safeString(skcRow?.skc_name||skcRow?.skcName,120);
    const target=group.find(m=>sameSheinSkc(m.skc,requested)) || (!requested && group.length===1 ? group[0] : null);
    if(!target) continue;
    skcRow.skc_name=target.skc;
    const skuRows=asArray(skcRow?.sku_list||skcRow?.skuList);
    if(skuRows.length===target.skuCodes.length){
      skuRows.forEach((sku,index)=>{ if(!safeString(sku?.sku_code||sku?.skuCode,80)) sku.sku_code=target.skuCodes[index]; });
    }
  }
  return body;
}
function imageInfoRows(container){ return asArray(container?.image_info_list || container?.imageInfoList); }
function imageRowType(row){
  const value = row?.image_type ?? row?.imageType;
  if(value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value).trim();
}
function imageRowSort(row){
  const n = Number(row?.image_sort ?? row?.imageSort ?? row?.sort ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function imageRowUrl(row){ return safeString(row?.image_url || row?.imageUrl || row?.url || '', 1000); }
function isSuspiciousTinySkuImageUrl(url){
  const text = String(url || '');
  return /(?:^|[\\/_-])sku[-_]?80(?:[.\\/_-]|$)|80x80/i.test(text);
}
function summarizeImageRows(rows, sourceLabel){
  const list = asArray(rows).map((row, index) => ({
    source: sourceLabel,
    index,
    image_sort: imageRowSort(row),
    image_type: imageRowType(row),
    image_url: imageRowUrl(row),
  }));
  const typeCounts = {};
  for(const row of list){
    const key = row.image_type || '(missing)';
    typeCounts[key] = (typeCounts[key] || 0) + 1;
  }
  return {rows:list, typeCounts};
}
function inspectSingleImageEditPayload(payload, index){
  const blockers=[];
  const warnings=[];
  const prefix=`imageEditPayload[${index}]`;
  const spuImageInfo = payload?.image_info || payload?.imageInfo || null;
  const spuSummary = summarizeImageRows(imageInfoRows(spuImageInfo), 'spu.image_info');
  const skcSummaries=[];
  const siteDetailRows=[];
  const skuRows=[];
  const skcList=asArray(payload?.skc_list || payload?.skcList);
  if(!payload || typeof payload !== 'object') blockers.push(`${prefix} 不是对象。`);
  if(payload && !payload.spu_name && !payload.spuName) blockers.push(`${prefix} 缺 spu_name，无法确认 partialEdit 目标 SPU。`);
  if(spuImageInfo && payload?.is_spu_pic !== true && payload?.isSpuPic !== true) {
    blockers.push(`${prefix} 提供了 SPU 层 image_info 但缺 is_spu_pic=true，商品轮播/主图可能不会按新版图片方案写入。`);
  }
  for(const row of spuSummary.rows){
    if(row.image_type && !['1','2','5'].includes(row.image_type)) blockers.push(`${prefix} SPU image_info image_type=${row.image_type} 非法，应为 1主图/2细节图/5方形图。`);
  }
  skcList.forEach((skc, skcIndex) => {
    const label=`skc_list[${skcIndex}]`;
    const imageInfo=skc?.image_info || skc?.imageInfo || null;
    const summary=summarizeImageRows(imageInfoRows(imageInfo), `${label}.image_info`);
    const typeCounts=summary.typeCounts;
    if(summary.rows.length){
      for(const row of summary.rows){
        if(!row.image_type) blockers.push(`${prefix} ${label}.image_info_list[${row.index}] 缺 image_type，SKC 图必须标明 1主图/2细节/5方形/6色块。`);
        else if(!['1','2','5','6'].includes(row.image_type)) blockers.push(`${prefix} ${label}.image_info_list[${row.index}] image_type=${row.image_type} 非法，只允许 1/2/5/6。`);
      }
      if((typeCounts['1'] || 0) !== 1) blockers.push(`${prefix} ${label} SKC 图片必须且只能有 1 张主图 image_type=1，当前 ${typeCounts['1'] || 0} 张。`);
      const main = summary.rows.find(row => row.image_type === '1');
      if(main && main.image_sort !== 1) warnings.push(`${prefix} ${label} 主图 image_sort=${main.image_sort}，建议主图排序为 1。`);
      if((typeCounts['2'] || 0) > 11) warnings.push(`${prefix} ${label} SKC 细节图 image_type=2 超过 11 张，当前 ${typeCounts['2']} 张；不同类目图片上限可能不同，提交前请用官方商品图片标准或平台预校验确认。`);
    }
    skcSummaries.push({skc_name: skc?.skc_name || skc?.skcName || '', ...summary});
    for(const group of asArray(skc?.site_detail_image_info_list || skc?.siteDetailImageInfoList)){
      for(const row of imageInfoRows(group)){
        siteDetailRows.push({
          source:`${label}.site_detail_image_info_list`,
          site_abbr_list: asArray(group?.site_abbr_list || group?.siteAbbrList || group?.site_abbr || group?.siteAbbr).map(x => safeString(x,80)).filter(Boolean),
          image_sort:imageRowSort(row),
          image_url:imageRowUrl(row),
        });
      }
    }
    for(const sku of asArray(skc?.sku_list || skc?.skuList)){
      for(const row of imageInfoRows(sku?.image_info || sku?.imageInfo)){
        const skuRow={
          source:`${label}.sku_list.image_info`,
          sku_code: safeString(sku?.sku_code || sku?.skuCode || '',120),
          image_sort:imageRowSort(row),
          image_type:imageRowType(row),
          image_url:imageRowUrl(row),
        };
        skuRows.push(skuRow);
        if(skuRow.image_type !== '1') blockers.push(`${prefix} SKU 图只允许主图 image_type=1，当前 ${skuRow.sku_code || '(unknown sku)'} 为 ${skuRow.image_type || '(missing)'}。`);
        if(isSuspiciousTinySkuImageUrl(skuRow.image_url)) blockers.push(`${prefix} SKU 图疑似引用 80x80/sku-80 裁切图：${skuRow.image_url}`);
      }
    }
  });
  const skcRows=skcSummaries.flatMap(item => item.rows);
  const allUrlRows=[...spuSummary.rows, ...skcRows, ...siteDetailRows, ...skuRows].filter(row => row.image_url);
  const skcDetailCount=skcRows.filter(row => row.image_type === '2').length;
  const totalDetailImages=skcDetailCount + siteDetailRows.length;
  if(totalDetailImages > 11) warnings.push(`${prefix} 细节图总数超过 11 张：SKC细节 ${skcDetailCount} + 站点详情 ${siteDetailRows.length} = ${totalDetailImages}；不同类目图片上限可能不同，提交前请用官方商品图片标准或平台预校验确认。`);
  if(!spuSummary.rows.length) warnings.push(`${prefix} 未提供 SPU 层 image_info；如果任务要求商品轮播/主图，请补 SPU image_info 并设置 is_spu_pic=true。`);
  if(!skuRows.length) warnings.push(`${prefix} 未提供 SKU 图；如果任务要求 SKU/色块图，请补 skc_list[].sku_list[].image_info。`);
  return {
    index,
    spu_name: payload?.spu_name || payload?.spuName || '',
    is_spu_pic: Boolean(payload?.is_spu_pic || payload?.isSpuPic),
    spuImageCount: spuSummary.rows.length,
    skcCount: skcList.length,
    skcImageCount: skcRows.length,
    skcTypeCounts: skcRows.reduce((acc,row)=>{ const k=row.image_type||'(missing)'; acc[k]=(acc[k]||0)+1; return acc; },{}),
    siteDetailImageCount: siteDetailRows.length,
    skuImageCount: skuRows.length,
    detailImageCount: totalDetailImages,
    urlRefCount: allUrlRows.length,
    uniqueUrlCount: new Set(allUrlRows.map(row => row.image_url)).size,
    spuRows: spuSummary.rows,
    skcRows,
    siteDetailRows,
    skuRows,
    blockers,
    warnings,
  };
}
function inspectImageEditPayloads(payloads, blockers, warnings){
  const inspections=asArray(payloads).map((payload,index)=>inspectSingleImageEditPayload(payload,index));
  for(const item of inspections){
    blockers.push(...item.blockers);
    warnings.push(...item.warnings);
  }
  return {
    payloadCount: inspections.length,
    totalSpuImages: inspections.reduce((sum,item)=>sum+item.spuImageCount,0),
    totalSkcImages: inspections.reduce((sum,item)=>sum+item.skcImageCount,0),
    totalSiteDetailImages: inspections.reduce((sum,item)=>sum+item.siteDetailImageCount,0),
    totalSkuImages: inspections.reduce((sum,item)=>sum+item.skuImageCount,0),
    totalDetailImages: inspections.reduce((sum,item)=>sum+item.detailImageCount,0),
    totalUrlRefs: inspections.reduce((sum,item)=>sum+item.urlRefCount,0),
    uniqueUrlCount: new Set(inspections.flatMap(item => [...item.spuRows, ...item.skcRows, ...item.siteDetailRows, ...item.skuRows].map(row => row.image_url).filter(Boolean))).size,
    blockers: inspections.flatMap(item => item.blockers),
    warnings: inspections.flatMap(item => item.warnings),
    payloads: inspections,
  };
}
async function loadClient(args){ const config=await readJson(args.config); const stores=Array.isArray(config.stores)?config.stores:Object.entries(config.stores||{}).map(([storeKey,v])=>({storeKey,...v})); const store=stores.find(s=>normalizeStoreKey(s?.storeKey||s?.key||s?.store)===normalizeStoreKey(args.store)); if(!store?.openKeyId||!store?.secretKey) throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`); return {config, store, client:new SheinOpenApiClient({baseUrl:config.apiBaseUrls?.prodSemiManaged||SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, openKeyId:store.openKeyId, secretKey:store.secretKey})}; }
function compactCallResult(name,pathText,method,response){ const info=response.data?.info; return {name,path:pathText,method,httpStatus:response.status??response.httpStatus??null,code:response.data?.code??response.code??null,msg:safeString(response.data?.msg??response.msg??'',300),traceId:response.data?.traceId??response.traceId??null,infoSuccess:info?.success??null,infoVersion:info?.version??null,preValidResult:info?.pre_valid_result??null,skcList:info?.skc_list??null}; }
async function callOpenApi(client, {name, path:pathText, method='POST', body, query}){ const response=await client.request(pathText,{method,body,query,headers:{language:'en'}}); return {...compactCallResult(name,pathText,method,response), data:response.data}; }
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
async function fetchSpuInfoForImages(client, matches, calls, warnings){
  const spuGroups=[...new Map(matches.filter(m=>m.spu).map(m=>[m.spu,m])).values()];
  const spuInfoMap=new Map();
  for(const m of spuGroups){
    try{
      const response=await client.request('/open-api/goods/spu-info',{method:'POST',body:{spuName:m.spu,languageList:['en','ar']},headers:{language:'en'}});
      calls.push(compactCallResult('spu-info-image-group','/open-api/goods/spu-info','POST',response));
      const info=response.data?.info;
      if(info&&typeof info==='object'){
        const spuImageRows=asArray(info.spuImageInfoList||info.spu_image_info_list||info.imageInfoList||info.image_info_list);
        const spuGroupCode=safeString(
          info.groupCode||info.group_code||info.imageGroupCode||info.image_group_code
          ||spuImageRows.find(row=>row?.groupCode||row?.group_code)?.groupCode
          ||spuImageRows.find(row=>row?.groupCode||row?.group_code)?.group_code
          ||'',120);
        const skcGroups={};
        for(const skcRow of asArray(info.skcInfoList||info.skc_info_list||info.skcList||info.skc_list)){
          const skcName=safeString(skcRow.skcName||skcRow.skc_name||skcRow.skc||'',160);
          const skcImageRows=asArray(skcRow.skcImageInfoList||skcRow.skc_image_info_list||skcRow.imageInfoList||skcRow.image_info_list);
          const skcGroupCode=safeString(
            skcRow.groupCode||skcRow.group_code||skcRow.imageGroupCode||skcRow.image_group_code
            ||skcImageRows.find(row=>row?.groupCode||row?.group_code)?.groupCode
            ||skcImageRows.find(row=>row?.groupCode||row?.group_code)?.group_code
            ||'',120);
          if(skcName&&skcGroupCode) skcGroups[normalizeSheinSkc(skcName)||skcName.toLowerCase()]=skcGroupCode;
        }
        if(spuGroupCode||Object.keys(skcGroups).length){
          spuInfoMap.set(m.spu,{spuGroupCode, skcGroups, productTypeId:info.productTypeId||info.product_type_id||null});
        }
      }
    }catch(e){
      warnings.push(`spu-info 查询失败 (${m.spu})：${safeString(e.message||e,200)}；image_group_code 将缺失，图片编辑可能被平台拒绝。`);
    }
  }
  return spuInfoMap;
}
function buildPayloads({task,intents,matches,siteInfo,blockers,warnings,imageEditPayloads=[],certificatePayloads=[],spuInfoMap=new Map(),inventoryWarehouseCode='' }){
  const command=String(task?.command||task?.text||''); const parameters=structuredTaskParameters(task); const out=[];
  const firstPartialEditIntent = intents.find(intent => intent === 'update_title' || intent === 'update_images') || '';
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
      const qty=numberForTask(intent,task,command); if(!Number.isFinite(qty)||qty<0) blockers.push('改库存任务缺少目标库存数量。请提供结构化 inventory 参数。');
      const items=matches.flatMap(m=>m.skuCodes.map(sku=>({idempotencyKey:`biops-${task.id||nowId()}-${m.storeKey}-${sku}-${Math.max(0,Math.trunc(qty||0))}`.slice(0,120), skuCode:sku, invType:'VI', ...(inventoryWarehouseCode?{warehouseCode:inventoryWarehouseCode}:{}), changeType:'OVERWRITE', changeQuantity:Math.max(0,Math.trunc(qty||0)), changeReason:'BI Ops guarded inventory update'})));
      if(!items.length) blockers.push('改库存任务未解析到 SKU code，无法构建库存更新 payload。');
      out.push({operation:intent, endpoint, body:{updateSkuInventoryQuantityRequests:items}, targetLinks:matches});
    } else if(intent==='update_supply_price'){
      const price=numberForTask(intent,task,command); if(!Number.isFinite(price)||price<=0) blockers.push('改供货价任务缺少目标供货价。请提供结构化 supplyPrice 参数。');
      const items=matches.filter(m=>m.skuCodes.length).map(m=>({skc_name:m.skc, change_price_reason_flag:'4', change_remark:'BI Ops guarded cost update', sku_info_list:m.skuCodes.map(sku=>({sku_code:sku,cost:Number(price.toFixed(2)),currency:'SAR'}))}));
      if(!items.length) blockers.push('改供货价任务未解析到 SKU code，无法构建成本价 payload。');
      out.push({operation:intent, endpoint, body:{spu_name:matches[0]?.spu||'', skc_info_list:items}, targetLinks:matches});
    } else if(intent==='update_product_price'){
      const price=numberForTask(intent,task,command); if(!Number.isFinite(price)||price<=0) blockers.push('改商品售价任务缺少目标售价。请提供结构化 productPrice 参数。');
      warnings.push('商品售价 API 同时写入 shopPrice 与 specialPrice，避免 SHEIN 将未传 specialPrice 解析为 0；真实执行前仍需人工复核当前活动价影响。');
      const productPriceList=matches.flatMap(m=>m.skuCodes.map(sku=>({productCode:sku,currencyCode:siteInfo.currency||'SAR',shopPrice:Number(price.toFixed(2)),specialPrice:Number(price.toFixed(2)),site:siteInfo.site,riseReason:'4'})));
      if(!productPriceList.length) blockers.push('改商品售价任务未解析到 SKU code，无法构建售价 payload。');
      out.push({operation:intent, endpoint, body:{productPriceList}, targetLinks:matches});
    } else if(intent==='update_title' || intent==='update_images'){
      if (intent !== firstPartialEditIntent) continue;
      const hasTitle=intents.includes('update_title');
      const hasImages=intents.includes('update_images');
      const title=hasTitle?safeString(parameters.title||parseTitleFromText(command),1000):'';
      const titleAr=hasTitle?safeString(parameters.titleAr||parseTitleArFromText(command),1000):'';
      const attrOverrides=parseAttributeOverrides(task);
      if(hasTitle && !title) blockers.push('改标题任务缺少新标题。请提供结构化 title 参数。');
      const imagePlans=hasImages?(Array.isArray(imageEditPayloads)?imageEditPayloads:[]):[];
      if(hasImages && !imagePlans.length) blockers.push('换图任务缺少完整 SHEIN partialEdit 图片 JSON：需提供 spu_name + image_info/skc_list/site_detail_image_info_list，或先通过图片上传/外链转换取得 SHEIN 图片 URL 后再提交。');
      const spuGroups=[...new Map(matches.map(m=>[m.spu,m])).values()].filter(m=>m.spu);
      if(!spuGroups.length) blockers.push('partialEdit 任务未解析到 SPU，无法构建 payload。');
      for(const m of spuGroups){
        let body={spu_name:m.spu};
        if(hasTitle){
          const lang=languageForTitle(title);
          const mlList=[{language:lang, name:title}];
          if(lang==='en' && titleAr) mlList.push({language:'ar', name:titleAr});
          body.multi_language_name_list=mlList;
          const skcTitle=titleAr || title;
          const skcList=matches.filter(x=>x.spu===m.spu).map(x=>({skc_name:x.skc, skc_title:skcTitle}));
          if(skcList.length) body.skc_list=skcList;
          if(attrOverrides.length) body.product_attribute_list=attrOverrides.map(a=>({attribute_id:a.attribute_id, attribute_value_id:a.attribute_value_id, attribute_extra_value:a.attribute_extra_value||''}));
          warnings.push('partialEdit 标题已覆盖 SKC skc_title（平台全量校验用 SKC 标题）；如商品有必填关联属性，已从 attributeOverrides 补齐。');
        }
        if(hasImages){
          const rawPlan=imagePlans.find(p=>compactRef(p.spu_name||p.spuName)===compactRef(m.spu)) || imagePlans[0];
          const plan=rawPlan?canonicalizeImagePlanTargets(rawPlan,matches.filter(x=>compactRef(x.spu)===compactRef(m.spu))):null;
          if(plan){
            if(plan.image_info){ body.image_info=plan.image_info; body.is_spu_pic=plan.is_spu_pic!==false; }
            if(plan.skc_list){
              if(body.skc_list){
                for(const oldSkc of body.skc_list){
                  const newSkc=plan.skc_list.find(s=>sameSheinSkc(s.skc_name||s.skcName,oldSkc.skc_name)||compactRef(s.skc_name||s.skcName)===compactRef(oldSkc.skc_name));
                  if(newSkc){ oldSkc.image_info=newSkc.image_info; if(newSkc.sku_list) oldSkc.sku_list=newSkc.sku_list; }
                }
              } else { body.skc_list=plan.skc_list; body.is_spu_pic=plan.is_spu_pic!==false; }
            }
            if(plan.site_detail_image_info_list) body.site_detail_image_info_list=plan.site_detail_image_info_list;
            ensureSquareImageSortGlobal(body);
            const spuInfo=spuInfoMap.get(m.spu);
            let injectedGroupCodeCount=0;
            let retainedGroupCodeCount=body.image_info?.image_group_code?1:0;
            for(const skc of asArray(body.skc_list)) if(skc?.image_info?.image_group_code) retainedGroupCodeCount+=1;
            if(spuInfo){
              if(spuInfo.spuGroupCode && body.image_info && !body.image_info.image_group_code){ body.image_info.image_group_code=spuInfo.spuGroupCode; injectedGroupCodeCount+=1; }
              if(spuInfo.skcGroups && body.skc_list){
                for(const skc of body.skc_list){
                  const gc=spuInfo.skcGroups[normalizeSheinSkc(skc.skc_name)||safeString(skc.skc_name,120).toLowerCase()];
                  if(gc && skc.image_info && !skc.image_info.image_group_code){ skc.image_info.image_group_code=gc; injectedGroupCodeCount+=1; }
                }
              }
            }
            if(injectedGroupCodeCount>0){
              warnings.push(`partialEdit 图片已注入 ${injectedGroupCodeCount} 个 image_group_code（来自 spu-info 实时查询）。`);
            } else if(retainedGroupCodeCount>0){
              warnings.push(`partialEdit 图片保留 payload 中已有的 ${retainedGroupCodeCount} 个 image_group_code；spu-info 未新增组码。`);
            } else {
              warnings.push('partialEdit 图片缺少 image_group_code：spu-info 未返回该 SPU 的图片组编码，平台可能拒绝图片编辑。');
            }
            warnings.push('partialEdit 图片已合并进同一调用；方形图 image_sort 已确保全局唯一。');
          }
        }
        out.push({operation:hasTitle&&hasImages?'update_title_and_images':intent, endpoint, body, targetLinks:matches.filter(x=>x.spu===m.spu)});
      }
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
async function readbackProduct(client, matches, calls){ const response=await client.request('/open-api/openapi-business-backend/product/query',{method:'POST',body:{pageNum:1,pageSize:100},headers:{language:'en'}}); calls.push(compactCallResult('product-query-readback','/open-api/openapi-business-backend/product/query','POST',response)); const rows=[]; const q=[response.data]; const seen=new Set(); while(q.length&&rows.length<500){ const cur=q.shift(); if(!cur||typeof cur!=='object'||seen.has(cur)) continue; seen.add(cur); if(Array.isArray(cur)){q.push(...cur); continue;} if(cur.skcName||cur.skc_name||cur.spuName||cur.spu_name||cur.supplierCode||cur.supplier_code||cur.skuCodeList||cur.skuCodes) rows.push(cur); q.push(...Object.values(cur)); } const matched=matches.filter(m=>rows.some(r=>productRowMatches(r,{skc:m.skc,spu:m.spu,standard:m.standardGoodsSn}))); return {ok:matched.length>0, status:matched.length?'matched_product_query':'not_matched_product_query', scannedRows:rows.length, matchedRows:matched.slice(0,20), calls}; }
async function readbackStock(client, matches, calls, expectedInventory){
  const skuCodes=unique(matches.flatMap(m=>m.skuCodes));
  if(!skuCodes.length) return {ok:false,status:'missing_sku_codes',matchedRows:[],calls};
  const response=await client.request('/open-api/stock/stock-query',{method:'POST',body:{skuCodeList:skuCodes,warehouseType:'2',invType:'VI'},headers:{language:'en'}});
  calls.push(compactCallResult('stock-query-readback','/open-api/stock/stock-query','POST',response));
  if(String(response.data?.code)!=='0') return {ok:false,status:'stock_query_failed',skuCodes:skuCodes.slice(0,100),matchedRows:[],calls};
  const rows=asArray(response.data?.info)
    .flatMap(group=>asArray(group?.goodsInventory))
    .flatMap(group=>asArray(group?.skuList));
  const missingSkuCodes=skuCodes.filter(sku=>!rows.some(row=>String(row?.skuCode||'')===sku));
  const mismatchedSkuCodes=Number.isFinite(expectedInventory)
    ? skuCodes.filter(sku=>{
      const row=rows.find(item=>String(item?.skuCode||'')===sku);
      return row && Number(row.totalUsableInventory)!==Number(expectedInventory);
    })
    : [];
  const ok=missingSkuCodes.length===0&&mismatchedSkuCodes.length===0;
  return {ok,status:ok?'matched_stock_query_exact':'stock_query_readback_mismatch',skuCodes:skuCodes.slice(0,100),missingSkuCodes,mismatchedSkuCodes,expectedInventory:Number.isFinite(expectedInventory)?expectedInventory:null,matchedRows:ok?matches.slice(0,20):[],calls};
}
async function readbackForIntents(client, intents, matches, calls, expectedInventory){
  const groups=[];
  if(intents.includes('update_inventory')) groups.push(await readbackStock(client,matches,calls,expectedInventory));
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
  const {config, client, store: configuredStore}=await loadClient({...args, store});
  const testWebhookGuard=createLoopbackTestWebhookWriteGuard({
    baseUrl:config.apiBaseUrls?.prodSemiManaged||SHEIN_OPENAPI_BASE_URLS.prodSemiManaged,
  });
  const storeInfo=await callOpenApi(client,{name:'store-info',path:'/open-api/openapi-business-backend/query-store-info',body:{}}).catch(e=>({error:e}));
  if(storeInfo.error) warnings.push(`店铺信息探针失败：${safeString(storeInfo.error.message||storeInfo.error)}`); else calls.push(compactCallResult(storeInfo.name,storeInfo.path,storeInfo.method,{status:storeInfo.httpStatus,data:storeInfo.data}));
  const truth=STORE_ACCOUNT_TRUTH.stores?.[store];
  if(truth && storeInfo.data){
    const identity=validateStoreIdentity({
      store:configuredStore,
      truth,
      storageIdentity: openApiIdentityToStorageIdentity(storeInfo.data),
      href:'openapi:/open-api/openapi-business-backend/query-store-info',
      context:'link_ops_maintenance_openapi_executor',
    });
    const acceptedByMerchantOnly=storeIdentityMatchesMerchantOnly(identity);
    if(!identity.ok && !acceptedByMerchantOnly) blockers.push(formatStoreIdentityError(identity));
    else if(acceptedByMerchantOnly) warnings.push(`${store} OpenAPI 店铺信息未返回 GS账号，但 merchantId=${identity.expectedMerchantId} 已匹配；若后续接口返回冲突 GS账号仍会阻断。`);
  }
  const siteInfo=await getDefaultSite(client,calls,warnings);
  let inventoryWarehouseCode='';
  if(intents.includes('update_inventory')){
    const warehouseResponse=await client.request('/open-api/msc/warehouse/list',{method:'GET',headers:{language:'en'}});
    calls.push(compactCallResult('warehouse-list','/open-api/msc/warehouse/list','GET',warehouseResponse));
    if(String(warehouseResponse.data?.code)!=='0'){
      blockers.push(`商家仓库列表查询失败：${safeString(warehouseResponse.data?.msg||warehouseResponse.data?.code||'未知错误')}`);
    }else{
      try{
        inventoryWarehouseCode=selectVirtualInventoryWarehouseCode(warehouseResponse.data?.info,{site:siteInfo.site});
      }catch(error){
        blockers.push(`无法唯一确定库存仓库：${safeString(error.message||error,240)}`);
      }
    }
  }
  const linkLoad=await loadLinkRows(args); if(linkLoad.error) warnings.push(`BI 链接快照不可读，将仅允许用实时精确 SKC 定位：${linkLoad.error}`);
  const productLoad=await loadProductRows(store,args); if(productLoad.error) warnings.push(`OpenAPI 商品缓存不可读，将只用链接快照：${productLoad.error}`);
  const jsonAssets=await loadJsonAssetPayloads(task);
  const taskWithJsonAssets={...task,_jsonAssets:jsonAssets};
  const snapshotResolved=resolveTargets({task, store, linkRows:linkLoad.rows||[], productRows:productLoad.rows||[]});
  const boundResolved=intents.includes('update_images')
    ? resolveApprovedImageBindingIdentity(task,store,snapshotResolved.missing,warnings)
    : {matches:[],unresolved:snapshotResolved.missing};
  const liveResolved=await resolveMissingExactSkcsFromOpenApi(client,store,boundResolved.unresolved,calls,warnings);
  const mergedMatches=[]; const mergedKeys=new Set();
  for(const match of [...snapshotResolved.matches,...boundResolved.matches,...liveResolved.matches]){ const key=`${match.storeKey}|${normalizeSheinSkc(match.skc)||compactRef(match.skc)}|${compactRef(match.spu)}`; if(mergedKeys.has(key)) continue; mergedKeys.add(key); mergedMatches.push(match); }
  const resolved={refs:snapshotResolved.refs,matches:mergedMatches,missing:liveResolved.unresolved};
  if(resolved.missing.length) blockers.push(`未定位到目标货号/SKC：${resolved.missing.join('、')}`);
  if(!resolved.matches.length) blockers.push('没有可执行目标链接。');
  const imageEditPayloads=intents.includes('update_images')
    ? normalizeImageEditPayloadsFromJsonAssets(taskWithJsonAssets,resolved.matches,warnings)
    : [];
  const imagePayloadInspection=intents.includes('update_images')
    ? inspectImageEditPayloads(imageEditPayloads,blockers,warnings)
    : inspectImageEditPayloads([],blockers,warnings);
  const certificatePayloads=normalizeCertificatePayloadsFromJsonAssets(taskWithJsonAssets,warnings);
  const spuInfoMap=intents.includes('update_images')
    ? await fetchSpuInfoForImages(client,resolved.matches,calls,warnings)
    : new Map();
  const payloads=buildPayloads({task:taskWithJsonAssets,intents,matches:resolved.matches,siteInfo,blockers,warnings,imageEditPayloads,certificatePayloads,spuInfoMap,inventoryWarehouseCode});
  const submitPlan={storeKey:store,intents,payloads:payloads.map(p=>({operation:p.operation,endpoint:p.endpoint,body:p.body,targetSkcs:p.targetLinks.map(x=>x.skc).filter(Boolean)}))};
  const payloadHash=payloads.some(p=>Object.keys(p.body||{}).length)?sha256Stable(submitPlan):'';
  if(args.mode==='execute'){
    const expected=safeString(executionContext?.expectedPayloadHash||executionContext?.request?.expectedPayloadHash||executionContext?.request?.payloadHash||'',120);
    if(args.confirm!==SUBMIT_CONFIRM_TEXT) blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    if(!expected) blockers.push('真实提交缺少 dry-run 锁定的 payload hash。');
    else if(!payloadHash||payloadHash!==expected) blockers.push(`真实提交 payload hash 与 dry-run 锁定值不一致：expected=${expected||'missing'} actual=${payloadHash||'missing'}`);
  }
  const taskParameters=structuredTaskParameters(task);
  const hasExpectedCurrentInventory=taskParameters.expectedCurrentInventory!==undefined
    && taskParameters.expectedCurrentInventory!==null
    && taskParameters.expectedCurrentInventory!=='';
  const expectedCurrentInventory=hasExpectedCurrentInventory
    ? Number(taskParameters.expectedCurrentInventory)
    : null;
  let inventoryPreflight=null;
  if(intents.includes('update_inventory')&&hasExpectedCurrentInventory){
    if(!Number.isInteger(expectedCurrentInventory)||expectedCurrentInventory<0){
      blockers.push(`库存写前漂移门禁的 expectedCurrentInventory 非法：${taskParameters.expectedCurrentInventory}`);
    }else if(resolved.matches.length){
      inventoryPreflight=await readbackStock(client,resolved.matches,calls,expectedCurrentInventory);
      if(!inventoryPreflight.ok){
        blockers.push(`库存写前漂移门禁不匹配：期望当前可用 ${expectedCurrentInventory}，异常 SKU=${[
          ...(inventoryPreflight.missingSkuCodes||[]),
          ...(inventoryPreflight.mismatchedSkuCodes||[]),
        ].join(',')||'unknown'}`);
      }
    }
  }
  let submitResults=[]; let actualWriteSubmitted=false;
  if(args.mode==='execute' && blockers.length===0){
    for(const p of payloads){
      const guardedWrite=await runSheinWebhookExternalWriteGuarded({
        writeStores:[store],
        guard:testWebhookGuard||undefined,
        write:()=>client.request(p.endpoint,{method:'POST',body:p.body,headers:{language:'en'}}),
      });
      if(!guardedWrite.ok){
        blockers.push(...(guardedWrite.gate?.blockers||['平台动态安全闸门阻止真实提交。']));
        break;
      }
      const response=guardedWrite.value;
      const compact=compactCallResult(p.operation,p.endpoint,'POST',response);
      calls.push(compact);
      submitResults.push({...compact, operation:p.operation});
      if(String(response.data?.code)!=='0'){
        blockers.push(`${p.operation} 返回失败：${safeString(response.data?.msg||response.data?.code||'未知错误')}`);
      }else if(response.data?.info?.success===false){
        const errs=(response.data?.info?.pre_valid_result||[]).map(v=>`[${v.form||v.module||''}] ${(v.messages||[]).join('; ')}`).join(' | ');
        blockers.push(`${p.operation} 校验失败：${errs||'info.success=false 但无详细错误'}`);
      }
    }
    actualWriteSubmitted=submitResults.some(r=>String(r.code)==='0' && r.infoSuccess!==false);
  }
  const readbackCalls=[]; let readback={ok:false,status:args.mode==='execute'?'not_run':'planned_not_run',calls:readbackCalls};
  const expectedInventory=intents.includes('update_inventory')?numberForTask('update_inventory',task,String(task?.command||task?.text||'')):null;
  if(actualWriteSubmitted){ readback=await readbackForIntents(client,intents,resolved.matches,readbackCalls,expectedInventory); }
  const state=args.mode==='execute' ? (actualWriteSubmitted?'submitted':'blocked') : (blockers.length?'blocked':'ready_for_submit');
  const output={ok:blockers.length===0, runId, mode:args.mode, adapterKind:'link_maintenance_openapi_executor', state, startedAt, endedAt:new Date().toISOString(), storeKey:store, task:{id:task.id||'',status:task.status||'',intents,productRefs:taskProductRefs(task)}, payload:{found:Boolean(payloadHash), payloadHash, payloadHashAlgorithm:payloadHash?'sha256-stable-json-v1':'', summary:{operations:payloads.map(p=>p.operation), endpoints:payloads.map(p=>p.endpoint), targetCount:resolved.matches.length, skuCount:unique(resolved.matches.flatMap(m=>m.skuCodes)).length, imagePayloadInspection:{payloadCount:imagePayloadInspection.payloadCount,totalSpuImages:imagePayloadInspection.totalSpuImages,totalSkcImages:imagePayloadInspection.totalSkcImages,totalSiteDetailImages:imagePayloadInspection.totalSiteDetailImages,totalSkuImages:imagePayloadInspection.totalSkuImages,totalDetailImages:imagePayloadInspection.totalDetailImages,totalUrlRefs:imagePayloadInspection.totalUrlRefs,uniqueUrlCount:imagePayloadInspection.uniqueUrlCount}}, submitPlan}, adapterEvidence:{realSubmit:actualWriteSubmitted, canSilentWrite:false, matchedLinksCount:resolved.matches.length, matchedLinks:resolved.matches.slice(0,80), linkSnapshotFile:linkLoad.file?rel(linkLoad.file):'', productCacheFile:productLoad.file?rel(productLoad.file):'', siteInfo, imagePayloadInspection, inventoryPreflight, calls}, publishResult: actualWriteSubmitted ? {code:'0', msg:'submitted', traceId:submitResults.map(x=>x.traceId).filter(Boolean).join(',')||null, operations:submitResults} : null, readbackFingerprint:{taskId:task.id||'', intents, targetStores:[store], matchedSkcs:resolved.matches.map(m=>m.skc).filter(Boolean), matchedSkuCodes:unique(resolved.matches.flatMap(m=>m.skuCodes)), payloadHash, readbackStatus:readback.status}, readback, blockers, warnings, safety:{canSilentWrite:false, executeRequiresConfirm:SUBMIT_CONFIRM_TEXT, dryRunDoesNotCallBusinessWrite:args.mode!=='execute', inventoryPreflightRequired:hasExpectedCurrentInventory, note:'维护写真实提交必须由 BI 账号店铺写权限、动作总闸门、payload hash 和确认文本共同放行；传入 expectedCurrentInventory 时还必须通过官方 OpenAPI 写前漂移门禁。'}};
  if(actualWriteSubmitted && !readback.ok){ output.ok=false; output.state='submitted'; output.blockers=[]; output.warnings.push('写接口返回成功但强回读未确认，任务必须锁定等待人工核销。'); }
  const outPath=path.join(args.outDir,`${runId}.local.json`); await writeJson(outPath,output); output.savedTo=rel(outPath); if(!args.quiet) console.log(JSON.stringify(output,null,2));
}

main().catch(err=>{ console.error(err?.stack||err?.message||String(err)); process.exit(1); });
