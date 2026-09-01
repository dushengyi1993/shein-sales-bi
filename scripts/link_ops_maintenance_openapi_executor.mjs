#!/usr/bin/env node
/**
 * SHEIN OpenAPI link-maintenance executor.
 *
 * Supports dry-run and guarded execute for maintenance actions that are backed
 * by official OpenAPI endpoints: activate_link, retire_link, update_inventory,
 * update_supply_price, update_product_price, update_title, update_images.
 * It never silently writes: execute requires the server-side task state, a
 * dry-run payload hash, a durable server-side write claim, safe write gates
 * and the explicit confirm text.
 *
 * Daily local Windows/Codex usage must not call real SHEIN OpenAPI; run real
 * maintenance writes only inside shein-bi-tencent/cloud runtime or fake tests.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {SheinOpenApiClient, SHEIN_OPENAPI_BASE_URLS} from '../lib/shein_openapi_client.mjs';
import {resolveOpenApiProductCacheDir, resolveOpenApiProductCacheFile} from '../lib/shein_openapi_product_cache.mjs';
import {selectVirtualInventoryWarehouseCode} from '../lib/shein_inventory_warehouse.mjs';
import {normalizeSheinSkc, sameSheinSkc} from '../lib/shein_product_identifiers.mjs';
import {
  extractExactDocumentState,
  validatePendingListingImageCorrection,
} from '../lib/link_ops_pending_listing_image_correction.mjs';
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
import {
  validateUpdateDescriptionBindingLock,
  validateUpdateDescriptionPayloadShape,
  evaluateUpdateDescriptionReadback,
  classifyUpdateDescriptionLifecycle,
  extractSpuInfoIdentity,
  sha256Utf8,
  DESCRIPTION_PUBLISH_LANGUAGES,
} from '../lib/link_ops_product_descriptions.mjs';
import {
  appendDurableJournalRecord,
  assertInventoryWriteAllowed,
  discoverInventoryJournalFiles,
  INVENTORY_MAINTENANCE_WRITE_PROFILE,
  inventoryRecoveryScopeKey,
  readInventoryIntentJournals,
  submitDurableInventoryWriteOnce,
} from '../lib/durable_inventory_write.mjs';
import {withInventoryCutoverLock} from '../lib/inventory_write_cutover.mjs';
import {
  computeInventoryOverwriteQuantity,
  INVENTORY_OVERWRITE_COMPUTATION_VERSION,
  stableInventoryHash,
} from '../lib/inventory_replenishment_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PRODUCT_CACHE_DIR = resolveOpenApiProductCacheDir({rootDir: ROOT});
const DEFAULT_CONFIG = process.env.SHEIN_OPENAPI_CONFIG_FILE || path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_TASK_FILE = path.join(ROOT, 'state', 'bi_link_ops_tasks.json');
const DEFAULT_OUT_DIR = path.join(ROOT, 'logs', 'link-ops-maintenance-openapi-executor');
const SUBMIT_CONFIRM_TEXT = 'SHEIN_OPENAPI_SUBMIT';
const INVENTORY_CHANGE_REASON = 'Owner-authorized daily inventory target after current-day ET and sales/exposure guard';
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
  update_description: {
    endpoint: '/open-api/goods/product/partialEdit',
    readbackKind: 'description',
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
  const args = {config: DEFAULT_CONFIG, taskFile: DEFAULT_TASK_FILE, taskId: '', taskJson: '', mode: 'dry-run', outDir: DEFAULT_OUT_DIR, store: '', confirm: '', claimNonce: '', dir: '', productCacheDir: DEFAULT_PRODUCT_CACHE_DIR, quiet: false, reconcilePendingOnly: false};
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
    else if (a === '--reconcile-pending-only') { args.mode = 'reconcile-pending-only'; args.reconcilePendingOnly = true; }
    else if (a === '--confirm') args.confirm = String(argv[++i] || '').trim();
    else if (a === '--claim-nonce') args.claimNonce = String(argv[++i] || '').trim();
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-id <id> --store DX --dry-run\n  node scripts/link_ops_maintenance_openapi_executor.mjs --task-json task.json --store DX --execute --confirm ${SUBMIT_CONFIRM_TEXT}\n\nLocal boundary:\n  do not run real execute from the local Windows/Codex machine; use the cloud BI executor instead.`);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['dry-run', 'execute', 'reconcile-pending-only'].includes(args.mode)) throw new Error(`Invalid --mode: ${args.mode}`);
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
function safeFilePart(value){ return String(value||'').trim().replace(/[^A-Za-z0-9_.-]/g,'_').slice(0,120) || 'unknown'; }
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
async function loadProductRows(store,args={}){ const file=resolveOpenApiProductCacheFile(store,{rootDir:ROOT,cacheDir:args.productCacheDir}); try{ const j=await readJson(file); return {file, rows:Array.isArray(j.normalizedRows)?j.normalizedRows:[]}; }catch(e){ return {file, rows:[], error:e.message}; } }
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
      spu,
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
  if(asArray(payload?.site_detail_image_info_list||payload?.siteDetailImageInfoList).length){
    blockers.push(`${prefix} site_detail_image_info_list 层级错误：官方 partialEdit schema 要求它位于精确 skc_list[] 目标内，禁止放在 SPU 顶层。`);
  }
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
async function loadClient(args){ const config=await readJson(args.config); const stores=Array.isArray(config.stores)?config.stores:Object.entries(config.stores||{}).map(([storeKey,v])=>({storeKey,...v})); const store=stores.find(s=>normalizeStoreKey(s?.storeKey||s?.key||s?.store)===normalizeStoreKey(args.store)); if(!store?.openKeyId||!store?.secretKey) throw new Error(`未在 ${rel(args.config)} 找到 ${args.store} 的 openKeyId/secretKey`); return {config, store, client:new SheinOpenApiClient({baseUrl:config.apiBaseUrls?.prodSemiManaged||SHEIN_OPENAPI_BASE_URLS.prodSemiManaged, openKeyId:store.openKeyId, secretKey:store.secretKey, inventoryStoreKey:normalizeStoreKey(args.store), inventoryJournalFile:args.inventoryJournalFile||''})}; }
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
async function fetchSpuInfoForImages(client, matches, calls, warnings, blockers){
  const requestedByKey=new Map();
  for(const match of matches){
    const rawSpu=trimSpuIdentity(match?.spu);
    if(!rawSpu) continue;
    const key=normalizeSpuIdentity(rawSpu);
    const variants=requestedByKey.get(key)||new Set();
    variants.add(rawSpu);
    requestedByKey.set(key,variants);
  }
  const spuGroups=[];
  for(const variantSet of requestedByKey.values()){
    const variants=[...variantSet];
    if(variants.length!==1){
      blockers.push(`spu-info 图片预检发现 SPU 大小写冲突：${variants.sort().join('/')}；已在发请求前阻断。`);
      continue;
    }
    const rawSpu=variants[0];
    const match=matches.find(row=>trimSpuIdentity(row?.spu)===rawSpu);
    if(match) spuGroups.push({...match,spu:rawSpu});
  }
  const spuInfoMap=new Map();
  for(const m of spuGroups){
    try{
      const response=await client.request('/open-api/goods/spu-info',{method:'POST',body:{spuName:m.spu,languageList:['en','ar']},headers:{language:'en'}});
      calls.push(compactCallResult('spu-info-image-group','/open-api/goods/spu-info','POST',response));
      const info=response.data?.info;
      const returnedSpu=trimSpuIdentity(info?.spuName||info?.spu_name);
      if(info&&typeof info==='object'&&returnedSpu===m.spu){
        const spuImageRows=asArray(info.spuImageInfoList||info.spu_image_info_list||info.imageInfoList||info.image_info_list);
        const spuGroupCode=safeString(
          info.groupCode||info.group_code||info.imageGroupCode||info.image_group_code
          ||spuImageRows.find(row=>row?.groupCode||row?.group_code)?.groupCode
          ||spuImageRows.find(row=>row?.groupCode||row?.group_code)?.group_code
          ||'',120);
        const skcGroups={};
        const skuSaleAttributesBySkc={};
        for(const skcRow of asArray(info.skcInfoList||info.skc_info_list||info.skcList||info.skc_list)){
          const skcName=safeString(skcRow.skcName||skcRow.skc_name||skcRow.skc||'',160);
          const skcKey=normalizeSheinSkc(skcName)||skcName.toLowerCase();
          const skcImageRows=asArray(skcRow.skcImageInfoList||skcRow.skc_image_info_list||skcRow.imageInfoList||skcRow.image_info_list);
          const skcGroupCode=safeString(
            skcRow.groupCode||skcRow.group_code||skcRow.imageGroupCode||skcRow.image_group_code
            ||skcImageRows.find(row=>row?.groupCode||row?.group_code)?.groupCode
            ||skcImageRows.find(row=>row?.groupCode||row?.group_code)?.group_code
            ||'',120);
          if(skcName&&skcGroupCode) skcGroups[skcKey]=skcGroupCode;
          const skuSaleAttributes={};
          for(const skuRow of asArray(skcRow.skuInfoList||skcRow.sku_info_list||skcRow.skuList||skcRow.sku_list)){
            const exactSkuCode=safeString(skuRow.skuCode||skuRow.sku_code||'',160);
            const skuCode=exactSkuCode.toLowerCase();
            if(!skuCode) continue;
            skuSaleAttributes[skuCode]={skuCode:exactSkuCode,saleAttributes:asArray(skuRow.saleAttributeList||skuRow.sale_attribute_list).map(attribute=>{
              const attributeId=Number(attribute?.attributeId??attribute?.attribute_id);
              const attributeValueId=Number(attribute?.attributeValueId??attribute?.attribute_value_id);
              const customAttributeValue=safeString(attribute?.customAttributeValue??attribute?.custom_attribute_value,200);
              const language=safeString(attribute?.language,20);
              return {
                ...(Number.isFinite(attributeId)&&attributeId>0?{attribute_id:attributeId}:{}),
                ...(Number.isFinite(attributeValueId)&&attributeValueId>0?{attribute_value_id:attributeValueId}:{}),
                ...(customAttributeValue?{custom_attribute_value:customAttributeValue}:{}),
                ...(language?{language}:{}),
              };
            }).filter(attribute=>attribute.attribute_id)};
          }
          if(skcName&&Object.keys(skuSaleAttributes).length) skuSaleAttributesBySkc[skcKey]=skuSaleAttributes;
        }
        if(spuGroupCode||Object.keys(skcGroups).length||Object.keys(skuSaleAttributesBySkc).length){
          spuInfoMap.set(m.spu,{spuGroupCode, skcGroups, skuSaleAttributesBySkc, productTypeId:info.productTypeId||info.product_type_id||null});
        }
      }else if(info&&typeof info==='object'){
        blockers.push(`spu-info 图片预检身份不精确：请求 ${m.spu}，返回 ${returnedSpu||'(missing)'}；大小写漂移不视为同一 SPU。`);
      }
    }catch(e){
      warnings.push(`spu-info 查询失败 (${m.spu})：${safeString(e.message||e,200)}；image_group_code 将缺失，图片编辑可能被平台拒绝。`);
    }
  }
  return spuInfoMap;
}
async function queryPendingCorrectionDocumentState(client, correction, calls, {label='pending-correction-state'}={}){
  const response=await client.request('/open-api/goods/query-document-state',{
    method:'POST',
    body:{spuList:[{spuName:correction.identity.spuName,version:correction.documentVersion}]},
    headers:{language:'zh-cn'},
  });
  calls.push(compactCallResult(label,'/open-api/goods/query-document-state','POST',response));
  if(!response.ok||String(response.data?.code)!=='0') return {ok:false,documentState:null,reason:safeString(response.data?.msg||response.data?.code||'query-document-state failed',300)};
  return extractExactDocumentState(response.data,correction.identity,correction.documentVersion);
}
// ---------------------------------------------------------------------------
// update_description (historical backfill) helpers: minimal partialEdit body,
// live pre-execution gates (spu-info identity + current description hash,
// query-document-state, check-edit-permission) and spu-info readback.
// ---------------------------------------------------------------------------

function spuInfoLiveDescriptionRows(info) {
  const rows = [];
  const q = [info];
  const seen = new Set();
  while (q.length && rows.length < 200) {
    const cur = q.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) { q.push(...cur); continue; }
    if (Array.isArray(cur.productMultiDescList)) {
      for (const row of cur.productMultiDescList) {
        const language = String(row?.language || '').toLowerCase();
        const text = String(row?.productDesc ?? row?.name ?? '');
        if (language) rows.push({language, text});
      }
    }
    q.push(...Object.values(cur));
  }
  return rows;
}

function descriptionHashesFromRows(rows) {
  const hashes = {};
  for (const row of rows) hashes[row.language] = sha256Utf8(row.text);
  return hashes;
}

// The description body never lives in the task record. It is read per-run
// from the portal-controlled runtime material file (relative pointer + file
// hash + payload hash) and stays in process memory only.
async function loadDescriptionUpdatePayload(task) {
  const ref = task?.descriptionUpdatePayloadRef;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !ref.relativePath) return null;
  const rootPrefix = path.resolve(ROOT);
  const raw = String(ref.relativePath || '');
  if (!raw || raw.includes('..') || raw.startsWith('/') || raw.startsWith('\\')) return null;
  const resolved = path.resolve(rootPrefix, raw);
  if (resolved !== rootPrefix && !resolved.startsWith(rootPrefix + path.sep)) return null;
  if (!resolved.endsWith('.json')) return null;
  let bytes;
  try { bytes = await fs.readFile(resolved); } catch { return null; }
  // Read side fail-closed: on POSIX the material file must not be
  // group/other readable or writable.
  if (process.platform !== 'win32') {
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || (stat.mode & 0o077) !== 0) return null;
  }
  const real = await fs.realpath(resolved).catch(() => null);
  if (!real || real.toLowerCase() !== resolved.toLowerCase()) return null;
  const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== String(ref.fileSha256 || '').toLowerCase()) return null;
  let payload = null;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (sha256Stable(payload) !== String(ref.payloadHash || '')) return null;
  return payload;
}

// Persistence projection: the description body text never leaves process
// memory. Anything persisted (executor output file, portal task record,
// history/audit) only carries hashes/counts for update_description payloads.
function projectUpdateDescriptionBodyForPersistence(body) {
  const rows = asArray(body?.multi_language_desc_list);
  const lineCounts = {};
  const hashes = {};
  for (const row of rows) {
    const language = String(row?.language || '').toLowerCase();
    const name = String(row?.name || '');
    if (!language) continue;
    lineCounts[language] = name === '' ? 0 : name.split('\n').length;
    hashes[language] = sha256Utf8(name);
  }
  return {
    sanitized: 'hash-count-only',
    bodyHash: sha256Stable(body),
    spuName: String(body?.spu_name || ''),
    descriptionCount: rows.length,
    descriptionLanguages: rows.map(row => String(row?.language || '')).filter(Boolean),
    descriptionLineCounts: lineCounts,
    descriptionHashes: hashes,
  };
}

function projectSubmitPlanForPersistence(submitPlan) {
  return {
    ...submitPlan,
    payloads: (Array.isArray(submitPlan?.payloads) ? submitPlan.payloads : []).map(p => ({
      ...p,
      body: p?.operation === 'update_description' ? projectUpdateDescriptionBodyForPersistence(p.body) : p.body,
    })),
  };
}

async function buildUpdateDescriptionPayloadPlan({task, matches, blockers, warnings}) {
  const sourceIdentity=exactSpuSourceFromMatches(matches);
  if (!sourceIdentity.ok) {
    blockers.push(`update_description 必须精确单 SPU（${sourceIdentity.status}：${sourceIdentity.variants.join('/') || '(empty)'}）`);
    return null;
  }
  const spu=sourceIdentity.spu;
  const payload = await loadDescriptionUpdatePayload(task);
  if (!payload) {
    blockers.push('update_description 任务缺少受控物化的描述材料文件（descriptionUpdatePayloadRef 缺失/哈希不符/路径非法）；必须先通过受控绑定完成审核 HTML 逐字核验。');
    return null;
  }
  const shape = validateUpdateDescriptionPayloadShape(payload);
  if (!shape.ok) {
    blockers.push(...shape.blockers);
    return null;
  }
  if (trimSpuIdentity(payload.spu_name) !== spu) {
    blockers.push(`update_description payload.spu_name(${payload.spu_name}) 与解析 SPU(${spu}) 不一致（大小写必须精确）`);
    return null;
  }
  const bindingGate = validateUpdateDescriptionBindingLock(task, payload);
  if (!bindingGate.ok) {
    blockers.push(...bindingGate.blockers);
    return null;
  }
  const targetLinks = matches.filter(match => trimSpuIdentity(match?.spu) === spu);
  warnings.push('update_description 将只提交最小 partialEdit body：spu_name + multi_language_desc_list(ar/en 各5行)；禁止任何 title/image/attribute 字段混入。');
  return {body: payload, targetLinks};
}

async function runUpdateDescriptionLivePreflight(client, task, matches, calls, blockers) {
  const sourceIdentity=exactSpuSourceFromMatches(matches);
  if (!sourceIdentity.ok) {
    blockers.push(`update_description 写前门禁需要唯一且大小写精确的 SPU（${sourceIdentity.status}：${sourceIdentity.variants.join('/') || '(empty)'}）`);
    return null;
  }
  const spu = sourceIdentity.spu;
  let spuInfo = null;
  try {
    const response = await client.request('/open-api/goods/spu-info', {method: 'POST', body: {spuName: spu, languageList: ['en', 'ar']}, headers: {language: 'en'}});
    calls.push(compactCallResult('spu-info-description-preflight', '/open-api/goods/spu-info', 'POST', response));
    if (String(response.data?.code) === '0' && response.data?.info && typeof response.data.info === 'object') {
      spuInfo = response.data.info;
    } else {
      blockers.push(`update_description spu-info 探针失败：${safeString(response.data?.msg || response.data?.code || '未知错误')}`);
    }
  } catch (error) {
    blockers.push(`update_description spu-info 探针异常：${safeString(error?.message || error, 240)}`);
  }
  const identity = spuInfo ? extractSpuInfoIdentity(spuInfo) : {spuName: '', skcNames: []};
  if (spuInfo && identity.spuName && trimSpuIdentity(identity.spuName) !== spu) {
    blockers.push(`update_description 身份门禁失败：spu-info 返回 ${identity.spuName}，期望 ${spu}`);
  } else if (spuInfo && !identity.spuName) {
    blockers.push(`update_description 身份门禁失败：spu-info 未返回可核验 SPU 身份（期望 ${spu}）`);
  }
  const currentHashes = spuInfo ? descriptionHashesFromRows(spuInfoLiveDescriptionRows(spuInfo)) : {};
  let documentState = null;
  try {
    const response = await client.request('/open-api/goods/query-document-state', {method: 'POST', body: {spuList: [{spuName: spu}]}, headers: {language: 'zh-cn'}});
    calls.push(compactCallResult('query-document-state-preflight', '/open-api/goods/query-document-state', 'POST', response));
    if (String(response.data?.code) === '0') {
      const rows = Array.isArray(response.data?.info?.data) ? response.data.info.data : [];
      const row = rows.find(item => trimSpuIdentity(item?.spuName) === spu);
      if (!row) {
        blockers.push('update_description 审核公文门禁失败：query-document-state 未返回该 SPU 记录，无法确认无审核公文');
      } else {
        const states = (Array.isArray(row.skcList) ? row.skcList : []).map(item => Number(item?.documentState ?? -99));
        const inAudit = states.filter(state => state === 1 || state === 5);
        if (inAudit.length) {
          blockers.push(`update_description 审核公文门禁失败：SPU 存在审核中/申诉中 SKC（documentState=${inAudit.join(',')}），禁止编辑`);
        }
        documentState = states.length ? [...new Set(states)].join(',') : 'none';
      }
    } else {
      blockers.push(`update_description 审核公文门禁失败：${safeString(response.data?.msg || response.data?.code || '未知错误')}`);
    }
  } catch (error) {
    blockers.push(`update_description 审核公文门禁异常：${safeString(error?.message || error, 240)}`);
  }
  let editable = null;
  let editReason = '';
  try {
    const response = await client.request('/open-api/goods/product/check-edit-permission', {method: 'POST', body: {spuName: spu}, headers: {language: 'zh-cn'}});
    calls.push(compactCallResult('check-edit-permission-preflight', '/open-api/goods/product/check-edit-permission', 'POST', response));
    if (String(response.data?.code) === '0' && typeof response.data?.info === 'object') {
      editable = response.data.info.editable === true;
      editReason = safeString(response.data.info.reason || '', 300);
      if (!editable) blockers.push(`update_description 编辑权限门禁失败：editable=false${editReason ? `（${editReason}）` : ''}`);
    } else {
      blockers.push(`update_description 编辑权限门禁失败：${safeString(response.data?.msg || response.data?.code || '未知错误')}`);
    }
  } catch (error) {
    blockers.push(`update_description 编辑权限门禁异常：${safeString(error?.message || error, 240)}`);
  }
  return {
    ok: blockers.length === 0,
    spu,
    spuInfoIdentity: identity.spuName,
    currentDescriptionHashes: currentHashes,
    documentState,
    editable,
    editReason,
  };
}

function descriptionPreflightFromTaskExecution(task, storeKey) {
  const target = String(storeKey || '').trim().toUpperCase();
  const runs = asArray(task?.execution?.linkMaintenanceExecutors);
  const candidates = runs.filter(run => {
    const runStore = String(run?.storeKey || '').trim().toUpperCase();
    return runStore === target || (runs.length === 1 && runStore);
  });
  for (const run of candidates) {
    const preflight = run?.adapterEvidence?.descriptionPreflight
      || run?.result?.adapterEvidence?.descriptionPreflight
      || null;
    if (preflight && typeof preflight === 'object') return preflight;
  }
  return null;
}

function parseDocumentStateSet(row) {
  const states = (Array.isArray(row?.skcList) ? row.skcList : [])
    .map(item => Number(item?.documentState ?? -99))
    .filter(value => Number.isInteger(value) && value >= 0);
  return states.length ? [...new Set(states)].sort().join(',') : '';
}

async function queryDocumentStateForSpu(client, spu, calls, label) {
  const response = await client.request('/open-api/goods/query-document-state', {
    method: 'POST',
    body: {spuList: [{spuName: spu}]},
    headers: {language: 'zh-cn'},
  });
  calls.push(compactCallResult(label, '/open-api/goods/query-document-state', 'POST', response));
  if (String(response.data?.code) !== '0') {
    return {ok: false, reason: safeString(response.data?.msg || response.data?.code || 'query-document-state failed', 300), row: null};
  }
  const rows = Array.isArray(response.data?.info?.data) ? response.data.info.data : [];
  const row = rows.find(item => trimSpuIdentity(item?.spuName) === trimSpuIdentity(spu));
  if (!row) return {ok: false, reason: 'query-document-state 未返回该 SPU 记录', row: null};
  return {ok: true, row, stateSet: parseDocumentStateSet(row)};
}

/**
 * Causality-gated readback for update_description. A hash match on spu-info
 * alone never proves submission: matched requires (1) the exact partialEdit
 * response version carried into the readback evidence, (2) the live spu-info
 * ar/en description hashes byte-equal to the binding, and (3) a
 * query-document-state read for exactly that spu showing an audit record or a
 * status transition vs the pre-write baseline. Any unverifiable piece keeps
 * the task pending/manual resolve.
 */
async function readbackUpdateDescription(client, task, matches, calls, beforePreflight = null, submittedVersion = '') {
  const sourceIdentity=exactSpuSourceFromMatches(matches);
  if (!sourceIdentity.ok) {
    return {ok: false, status: 'update_description_readback_spu_not_unique', matchedRows: [], calls};
  }
  const spu = sourceIdentity.spu;
  const version = String(submittedVersion || '').trim();
  if (!version) {
    return {
      ok: false,
      status: 'description_readback_version_unverified',
      needsManualResolve: true,
      blockers: ['回读缺少 partialEdit 返回的 info.version，无法建立版本因果，不能判定提交成功'],
      matchedRows: [],
      calls,
    };
  }
  let info = null;
  try {
    const response = await client.request('/open-api/goods/spu-info', {method: 'POST', body: {spuName: spu, languageList: ['en', 'ar']}, headers: {language: 'en'}});
    calls.push(compactCallResult('spu-info-description-readback', '/open-api/goods/spu-info', 'POST', response));
    if (String(response.data?.code) === '0' && response.data?.info && typeof response.data.info === 'object') info = response.data.info;
  } catch (error) {
    calls.push({name: 'spu-info-description-readback', path: '/open-api/goods/spu-info', method: 'POST', httpStatus: null, code: null, msg: safeString(error?.message || error, 300), traceId: null});
  }
  if (!info) return {ok: false, status: 'update_description_readback_unverifiable', matchedRows: [], calls};
  const returnedSpu=trimSpuIdentity(info?.spuName||info?.spu_name);
  if(returnedSpu!==spu){
    return {ok:false,status:'update_description_readback_spu_identity_mismatch',needsManualResolve:true,matchedRows:[],evidence:{requestedSpu:spu,returnedSpu},calls};
  }
  const gate = evaluateUpdateDescriptionReadback(task?.descriptionMaterialBinding || null, info, {expectedSpuName: spu});
  const binding = task?.descriptionMaterialBinding || null;
  let documentStateEvidence = null;
  try {
    const after = await queryDocumentStateForSpu(client, spu, calls, 'query-document-state-readback');
    const beforeSet = String(beforePreflight?.documentState || '').trim();
    if (!after.ok) {
      documentStateEvidence = {ok: false, reason: after.reason, beforeStateSet: beforeSet, afterStateSet: ''};
    } else {
      const inAudit = (Array.isArray(after.row.skcList) ? after.row.skcList : [])
        .map(item => Number(item?.documentState ?? -99))
        .filter(value => value === 1 || value === 5);
      const transitionObserved = Boolean(
        (after.stateSet && after.stateSet !== beforeSet)
        || inAudit.length > 0
      );
      const rowVersions = [
        String(after.row?.version || ''),
        ...(Array.isArray(after.row?.skcList) ? after.row.skcList : []).map(skc => String(skc?.version || '')),
      ].map(value => value.trim()).filter(Boolean);
      // Causality requires a provable submitted version: if the audit record
      // exposes versions, at least one must equal the partialEdit-returned
      // version. If NO version field is returned at all, the state change
      // cannot be attributed to this submission, so the task must stay
      // pending/manual resolve instead of matching.
      const versionMatched = rowVersions.length === 0 ? false : rowVersions.some(value => value === version);
      documentStateEvidence = {
        ok: transitionObserved && versionMatched === true,
        reason: !transitionObserved
          ? `query-document-state 未观察到审核记录/状态转换（before=${beforeSet || '(none)'} after=${after.stateSet || '(none)'}）`
          : (versionMatched === false
            ? (rowVersions.length === 0
              ? 'query-document-state 未返回任何 version 字段，无法建立与 partialEdit 返回版本的因果证据；不能把状态变化归因本次提交，必须等待后续精确核销机制'
              : `query-document-state 返回的版本（${rowVersions.join('/')}）与 partialEdit 返回版本（${version}）不一致`)
            : ''),
        beforeStateSet: beforeSet,
        afterStateSet: after.stateSet,
        inAudit: inAudit.length > 0,
        versionMatched,
      };
    }
  } catch (error) {
    documentStateEvidence = {ok: false, reason: safeString(error?.message || error, 300), beforeStateSet: String(beforePreflight?.documentState || ''), afterStateSet: ''};
  }
  const versionCausal = Boolean(version);
  const fingerprint = {
    submittedVersion: version,
    versionCausal,
    documentStateBefore: beforePreflight?.documentState || null,
    documentStateAfter: documentStateEvidence?.afterStateSet || null,
    documentStateTransitionVerified: Boolean(documentStateEvidence?.ok),
    beforeHashes: beforePreflight?.currentDescriptionHashes || null,
    expectedAfterHashes: {
      ar: String(binding?.hashes?.ar || ''),
      en: String(binding?.hashes?.en || ''),
    },
    afterHashes: descriptionHashesFromRows(spuInfoLiveDescriptionRows(info)),
  };
  const blockers = [...(gate.blockers || [])];
  if (!documentStateEvidence?.ok) blockers.push(documentStateEvidence?.reason || '审核记录/状态转换无法核验');
  const matched = Boolean(gate.ok && versionCausal && documentStateEvidence?.ok);
  return {
    ok: matched,
    status: matched
      ? 'description_readback_matched'
      : (!versionCausal
        ? 'description_readback_version_unverified'
        : (!gate.ok
          ? gate.status
          : 'description_readback_document_state_unverified')),
    needsManualResolve: !matched,
    summary: gate.summary || null,
    blockers,
    fingerprint,
    documentStateEvidence,
    matchedRows: matched ? matches.slice(0, 20) : [],
    calls,
  };
}
async function waitForPendingCorrectionState(client, correction, expectedState, calls){
  const attempts=Math.max(1,Math.min(8,Number(process.env.SHEIN_PENDING_IMAGE_CORRECTION_STATE_ATTEMPTS||4)));
  const delayMs=Math.max(0,Math.min(5000,Number(process.env.SHEIN_PENDING_IMAGE_CORRECTION_STATE_DELAY_MS||750)));
  let latest=null;
  for(let attempt=1;attempt<=attempts;attempt+=1){
    latest=await queryPendingCorrectionDocumentState(client,correction,calls,{label:`pending-correction-state-${attempt}`});
    if(latest.ok&&latest.documentState===expectedState) return {...latest,attempts:attempt};
    if(attempt<attempts&&delayMs>0) await new Promise(resolve=>setTimeout(resolve,delayMs));
  }
  return {...(latest||{}),ok:false,attempts,reason:latest?.reason||`documentState did not become ${expectedState}`};
}
function correctionResponseSucceeded(response){
  if(!response?.ok||String(response.data?.code)!=='0') return false;
  return !(response.data?.info&&typeof response.data.info==='object'&&response.data.info.success===false);
}
async function buildPayloads({task,intents,matches,siteInfo,blockers,warnings,imageEditPayloads=[],certificatePayloads=[],spuInfoMap=new Map(),inventoryWarehouseCode='' }){
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
      const items=matches.flatMap(m=>m.skuCodes.map(sku=>({skuCode:sku, invType:'VI', ...(inventoryWarehouseCode?{warehouseCode:inventoryWarehouseCode}:{}), changeType:'OVERWRITE', changeQuantity:Math.max(0,Math.trunc(qty||0)), changeReason:INVENTORY_CHANGE_REASON})));
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
    } else if(intent==='update_description'){
      const plan=await buildUpdateDescriptionPayloadPlan({task,matches,blockers,warnings});
      if(plan) out.push({operation:intent, endpoint, body:plan.body, targetLinks:plan.targetLinks});
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
                  if(newSkc){
                    oldSkc.image_info=newSkc.image_info;
                    if(newSkc.site_detail_image_info_list) oldSkc.site_detail_image_info_list=newSkc.site_detail_image_info_list;
                    if(newSkc.sku_list) oldSkc.sku_list=newSkc.sku_list;
                  }
                }
              } else { body.skc_list=plan.skc_list; body.is_spu_pic=plan.is_spu_pic!==false; }
            }
            if(plan.site_detail_image_info_list) blockers.push('换图 payload 的 site_detail_image_info_list 位于 SPU 顶层；官方 partialEdit schema 要求绑定到精确 skc_list[]，已阻断提交。');
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
              let injectedSkuSaleAttributeCount=0;
              for(const skc of asArray(body.skc_list)){
                const skcKey=normalizeSheinSkc(skc?.skc_name)||safeString(skc?.skc_name,120).toLowerCase();
                const liveSkuAttributes=spuInfo.skuSaleAttributesBySkc?.[skcKey]||{};
                for(const sku of asArray(skc?.sku_list)){
                  if(!sku?.image_info||Object.prototype.hasOwnProperty.call(sku,'sale_attribute_list')) continue;
                  const skuKey=safeString(sku.sku_code||sku.skuCode,160).toLowerCase();
                  if(Object.prototype.hasOwnProperty.call(liveSkuAttributes,skuKey)){
                    sku.sku_code=liveSkuAttributes[skuKey].skuCode;
                    sku.sale_attribute_list=JSON.parse(JSON.stringify(liveSkuAttributes[skuKey].saleAttributes));
                    injectedSkuSaleAttributeCount+=1;
                  } else {
                    blockers.push(`SKU 图片编辑缺少实时销售属性：${safeString(sku.sku_code||sku.skuCode,160)}；已阻断提交，避免平台把图片编辑误判为不完整 SKU 编辑。`);
                  }
                }
              }
              if(injectedSkuSaleAttributeCount>0) warnings.push(`partialEdit SKU 图片已原样注入 ${injectedSkuSaleAttributeCount} 个 SKU 的实时 sale_attribute_list（来自 spu-info）。`);
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
const SPU_INFO_READBACK_PATH='/open-api/goods/spu-info';
const IMAGE_URL_READBACK_POLICY='host-lowercase+path-exact+query-key-value-sorted;scheme-and-fragment-ignored';
function trimSpuIdentity(value){ return String(value||'').trim(); }
function normalizeSpuIdentity(value){ return String(value||'').trim().toLowerCase(); }
function exactSpuSourceFromMatches(matches){
  const variants=unique(asArray(matches).map(match=>trimSpuIdentity(match?.spu)).filter(Boolean));
  const normalized=unique(variants.map(normalizeSpuIdentity));
  if(!variants.length) return {ok:false,status:'spu_identity_missing',spu:'',variants};
  if(normalized.length!==1) return {ok:false,status:'spu_identity_not_unique',spu:'',variants};
  if(variants.length!==1) return {ok:false,status:'spu_identity_case_conflict',spu:'',variants};
  return {ok:true,status:'spu_identity_exact',spu:variants[0],variants};
}
function canonicalDecimal(value){
  const text=String(value??'').trim();
  const match=text.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if(!match) return null;
  const negative=match[1]==='-';
  const integer=(match[2].replace(/^0+(?=\d)/,'')||'0');
  const fraction=String(match[3]||'').replace(/0+$/,'');
  const zero=integer==='0'&&!fraction;
  return `${negative&&!zero?'-':''}${integer}${fraction?`.${fraction}`:''}`;
}
function canonicalImageUrl(value){
  try{
    const parsed=new URL(String(value||'').trim());
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password) return null;
    const queryRows=[...parsed.searchParams.entries()].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
    const query=new URLSearchParams(queryRows).toString();
    const host=`${parsed.hostname.toLowerCase()}${parsed.port?`:${parsed.port}`:''}`;
    const pathname=parsed.pathname||'/';
    return {host,pathname,query,key:`${host}${pathname}${query?`?${query}`:''}`,policy:IMAGE_URL_READBACK_POLICY};
  }catch{return null;}
}
function normalizeLiveImageType(value){
  const numeric=Number(value);
  if(Number.isInteger(numeric)&&[1,2,5,6,7].includes(numeric)) return String(numeric);
  const text=String(value||'').trim().toUpperCase();
  if(['MAIN','MAIN_IMAGE','PRIMARY'].includes(text)) return '1';
  if(['DETAIL','DETAIL_IMAGE','DESC','DESCRIPTION'].includes(text)) return '2';
  if(['SQUARE','SQUARE_IMAGE','BLOCK','BLOCK_IMAGE'].includes(text)) return '5';
  if(['COLOR','COLOR_BLOCK','COLOR_SWATCH','SWATCH'].includes(text)) return '6';
  return '';
}
function normalizeImageEvidenceRow(row,{live=false,siteDetail=false}={}){
  const rawSort=live
    ? (row?.sort??row?.imageSort??row?.image_sort)
    : (row?.image_sort??row?.imageSort??row?.sort);
  const sort=Number(rawSort);
  const rawUrl=live ? row?.imageUrl : (row?.image_url??row?.imageUrl);
  const url=canonicalImageUrl(rawUrl);
  const type=siteDetail?'7':(live?normalizeLiveImageType(row?.imageType):normalizeLiveImageType(row?.image_type??row?.imageType));
  return {
    type,
    sort:Number.isInteger(sort)&&sort>0?sort:null,
    url:url?.key||'',
    host:url?.host||'',
    path:url?.pathname||'',
    query:url?.query||'',
    valid:Boolean(type&&Number.isInteger(sort)&&sort>0&&url),
  };
}
function compareImageRowsExact(expectedRows,liveRows,{siteDetail=false}={}){
  const expected=asArray(expectedRows).map(row=>normalizeImageEvidenceRow(row,{siteDetail})).sort((a,b)=>(a.sort??0)-(b.sort??0)||a.type.localeCompare(b.type)||a.url.localeCompare(b.url));
  const actual=asArray(liveRows).map(row=>normalizeImageEvidenceRow(row,{live:true,siteDetail})).sort((a,b)=>(a.sort??0)-(b.sort??0)||a.type.localeCompare(b.type)||a.url.localeCompare(b.url));
  const expectedComparable=expected.map(({type,sort,url})=>({type,sort,url}));
  const actualComparable=actual.map(({type,sort,url})=>({type,sort,url}));
  const ok=expected.length>0
    &&expected.every(row=>row.valid)
    &&actual.every(row=>row.valid)
    &&stableJson(expectedComparable)===stableJson(actualComparable);
  return {ok,expected:expectedComparable,actual:actualComparable,urlPolicy:IMAGE_URL_READBACK_POLICY};
}
function exactSpuEntry(cache,spu){
  const requestedSpu=trimSpuIdentity(spu);
  const entry=cache.get(normalizeSpuIdentity(requestedSpu))||null;
  if(!entry||entry.requestedSpu===requestedSpu) return entry;
  return {...entry,ok:false,status:'spu_info_requested_identity_case_conflict',lookupSpu:requestedSpu};
}
function exactSkcIdentityMatches(left,right){
  const leftRaw=String(left||'').trim();
  const rightRaw=String(right||'').trim();
  return Boolean(leftRaw&&rightRaw&&(leftRaw===rightRaw||sameSheinSkc(leftRaw,rightRaw)));
}
function exactSkcRows(info,skc){ return asArray(info?.skcInfoList||info?.skc_info_list).filter(row=>exactSkcIdentityMatches(row?.skcName||row?.skc_name,skc)); }
function exactSkuRows(skcInfo,sku){ return asArray(skcInfo?.skuInfoList||skcInfo?.sku_info_list).filter(row=>String(row?.skuCode??row?.sku_code??'')===String(sku||'')); }
function exactSiteRows(skcInfo,site){
  const expected=String(site||'').trim().toLowerCase();
  return asArray(skcInfo?.shelfStatusInfoList||skcInfo?.shelf_status_info_list).filter(row=>String(row?.siteAbbr??row?.site_abbr??'').trim().toLowerCase()===expected);
}
function matchForExactSkc(matches,skc){
  const rows=matches.filter(match=>exactSkcIdentityMatches(match?.skc,skc));
  const spus=unique(rows.map(row=>trimSpuIdentity(row?.spu)).filter(Boolean));
  return rows.length===1&&spus.length===1?rows[0]:null;
}
function payloadAliasesForIntent(intent){ return intent==='update_title'||intent==='update_images'?[intent,'update_title_and_images']:[intent]; }
function submissionPlanDescriptor(payload,index){
  const operation=String(payload?.operation||'').trim();
  const endpoint=String(payload?.endpoint||'').trim();
  const payloadBodyHash=sha256Stable(payload?.body||{});
  const submissionPlanId=sha256Stable({index,operation,endpoint,payloadBodyHash});
  return {index,operation,endpoint,payloadBodyHash,submissionPlanId};
}
function inventoryJournalFileForMaintenanceTask(args,{task,store}){
  const journalDir=String(process.env.SHEIN_BI_MAINTENANCE_INVENTORY_JOURNAL_DIR||'').trim()||args.outDir;
  return path.join(journalDir, 'maintenance-inventory-' + safeFilePart(store) + '-' + safeFilePart(task?.id||'task') + '.json.journal.ndjson');
}
function todayShanghai(){ return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()); }
function inventoryScopeForPayload({store,match,requestRow}){
  return {storeKey:normalizeStoreKey(store||match?.storeKey),skc:String(match?.skc||''),skuCode:String(requestRow?.skuCode||''),warehouseCode:String(requestRow?.warehouseCode||''),invType:String(requestRow?.invType||'VI').trim().toUpperCase()};
}
function buildMaintenanceInventoryIntent({task,store,match,requestRow,planHash,runDate,authorizationId,before}){
  const target=Number(requestRow?.changeQuantity);
  const scope=inventoryScopeForPayload({store,match,requestRow});
  const policyVersion=INVENTORY_MAINTENANCE_WRITE_PROFILE;
  const logicalActionKey=stableInventoryHash({runDate,store:scope.storeKey,skc:scope.skc,sku:scope.skuCode,target,actionType:'VI_OVERWRITE_TO_EXACT_USABLE_TARGET',policyVersion,authorizationId});
  const request={pathname:'/open-api/stock/change-inventory/v2',method:'POST',body:{updateSkuInventoryQuantityRequests:[{idempotencyKey:'bi-inv-'+logicalActionKey.slice(0,42),skuCode:scope.skuCode,invType:'VI',...(scope.warehouseCode?{warehouseCode:scope.warehouseCode}:{}),changeType:'OVERWRITE',changeQuantity:computeInventoryOverwriteQuantity(target,before),changeReason:INVENTORY_CHANGE_REASON}]},headers:{language:'en'}};
  return {kind:'intent',intentId:crypto.randomUUID(),logicalActionKey,recoveryScopeKey:inventoryRecoveryScopeKey(scope),planHash,runDate,storeKey:scope.storeKey,skc:scope.skc,skuCode:scope.skuCode,warehouseCode:scope.warehouseCode,invType:'VI',targetUsableInventory:target,policyVersion,inventoryWriteProfile:INVENTORY_MAINTENANCE_WRITE_PROFILE,overwriteComputationVersion:INVENTORY_OVERWRITE_COMPUTATION_VERSION,authorizationId,idempotencyKey:request.body.updateSkuInventoryQuantityRequests[0].idempotencyKey,requestPayloadHash:stableInventoryHash(request),request,before:{...before,stockRowMissing:before?.stockRowMissing===true},maintenanceTaskId:String(task?.id||''),maintenancePayloadHash:planHash,recordedAt:new Date().toISOString()};
}
function assertSingleInventoryTarget({matches,payloads}){
  const inventoryPayloads=payloads.filter(payload=>payload.operation==='update_inventory');
  const rows=inventoryPayloads.flatMap(payload=>asArray(payload.body?.updateSkuInventoryQuantityRequests).map(row=>({payload,row})));
  const skcs=unique(matches.map(match=>String(match?.skc||'')).filter(Boolean));
  const skus=unique(rows.map(({row})=>String(row?.skuCode||'')).filter(Boolean));
  const warehouses=unique(rows.map(({row})=>String(row?.warehouseCode||'')).filter(Boolean));
  if(inventoryPayloads.length!==1||rows.length!==1||matches.length!==1||skcs.length!==1||skus.length!==1||warehouses.length!==1){
    const error=new Error('INVENTORY_MAINTENANCE_TARGET_NOT_UNIQUE: update_inventory requires exactly one link/SKC/SKU/warehouse before durable intent');
    error.code='INVENTORY_MAINTENANCE_TARGET_NOT_UNIQUE';
    throw error;
  }
  return {payload:rows[0].payload,row:rows[0].row,match:matches[0],warehouseCode:warehouses[0]};
}
async function readMaintenanceInventoryBundle(journalFile){
  const dirs=String(process.env.SHEIN_BI_INVENTORY_JOURNAL_DIRS||'').split(path.delimiter).map(v=>v.trim()).filter(Boolean);
  const files=await discoverInventoryJournalFiles(journalFile,{includeAll:true,additionalDirectories:dirs});
  return readInventoryIntentJournals(files,{allowMultiplePendingByScope:true});
}
function findInventoryLifecycleDuplicate(bundle,intent){
  for(const candidate of bundle?.intents?.values?.()||[]){
    const sameLogical=String(candidate?.logicalActionKey||'')===intent.logicalActionKey;
    const sameIdempotency=String(candidate?.idempotencyKey||'')===intent.idempotencyKey;
    if(!sameLogical&&!sameIdempotency) continue;
    const samePayload=String(candidate?.requestPayloadHash||'')===intent.requestPayloadHash;
    return {candidate,samePayload};
  }
  return null;
}
function exactInventoryRow(readback,skuCode){
  if(readback?.ok!==true) return null;
  const rows=asArray(readback?.rows).filter(row=>String(row?.skuCode||'')===String(skuCode||'')&&row?.inventoryFieldsValid===true);
  return rows.length===1?rows[0]:null;
}
function inventoryReadbackError(readback,prefix='INVENTORY_FRESH_STOCK_ROW_REQUIRED'){
  const details={
    status:readback?.status||'not_run',
    missingSkuCodes:readback?.missingSkuCodes||[],
    ambiguousSkuCodes:readback?.ambiguousSkuCodes||[],
    wrongWarehouseSkuCodes:readback?.wrongWarehouseSkuCodes||[],
    invalidInventorySkuCodes:readback?.invalidInventorySkuCodes||[],
    mismatchedSkuCodes:readback?.mismatchedSkuCodes||[],
  };
  const error=new Error(prefix+':'+JSON.stringify(details));
  error.code=prefix;
  return error;
}
async function prepareMaintenanceInventorySubmission({
  client,task,store,match,requestRow,payloadHash,authorizationId,journalFile,calls,expectedCurrentInventory,
}){
  const requestedScope=inventoryScopeForPayload({store,match,requestRow});
  const initialBundle=await readMaintenanceInventoryBundle(journalFile);
  const priorSameTask=[...(initialBundle?.intents?.values?.()||[])].find(candidate=>
    String(candidate?.inventoryWriteProfile||'')===INVENTORY_MAINTENANCE_WRITE_PROFILE
    &&String(candidate?.maintenanceTaskId||'')===String(task?.id||'')
    &&inventoryRecoveryScopeKey(candidate)===inventoryRecoveryScopeKey(requestedScope));
  if(priorSameTask){
    const samePayload=String(priorSameTask?.maintenancePayloadHash||'')===String(payloadHash||'');
    const code=samePayload?'INVENTORY_WRITE_ALREADY_RECORDED':'INVENTORY_WRITE_HASH_OR_SCOPE_DRIFT';
    const error=new Error(code+':intentId='+(priorSameTask?.intentId||'')+':logicalActionKey='+(priorSameTask?.logicalActionKey||''));
    error.code=code;
    throw error;
  }
  const live=await readbackStock(
    client,
    [{...match,skuCodes:[String(requestRow?.skuCode||'')]}],
    calls,
    Number.isInteger(expectedCurrentInventory)?expectedCurrentInventory:null,
    String(requestRow?.warehouseCode||''),
  );
  const before=exactInventoryRow(live,requestRow?.skuCode);
  if(!before) throw inventoryReadbackError(live);
  const intent=buildMaintenanceInventoryIntent({
    task,store,match,requestRow,planHash:payloadHash,runDate:todayShanghai(),authorizationId,before,
  });
  const intentRow=intent.request.body.updateSkuInventoryQuantityRequests[0];
  const scope=inventoryScopeForPayload({store,match,requestRow:intentRow});
  const bundle=await readMaintenanceInventoryBundle(journalFile);
  const duplicate=findInventoryLifecycleDuplicate(bundle,intent);
  if(duplicate){
    const code=duplicate.samePayload?'INVENTORY_WRITE_ALREADY_RECORDED':'INVENTORY_WRITE_HASH_OR_SCOPE_DRIFT';
    const error=new Error(code+':intentId='+(duplicate.candidate?.intentId||'')+':logicalActionKey='+(duplicate.candidate?.logicalActionKey||''));
    error.code=code;
    throw error;
  }
  assertInventoryWriteAllowed(bundle,{
    scope,
    idempotencyKey:intent.idempotencyKey,
    requestPayloadHash:intent.requestPayloadHash,
    intentId:intent.intentId,
    logicalActionKey:intent.logicalActionKey,
  });
  await client.assertInventoryFence(intent.request.pathname,intent.request.method,intent.request.body,intent.request.headers,{
    ...scope,
    requestPayloadHash:intent.requestPayloadHash,
    intentId:intent.intentId,
    logicalActionKey:intent.logicalActionKey,
  });
  return {
    intent,
    inventoryScope:scope,
    fenceBundle:bundle,
    inventoryPreflight:live,
    assertInventoryAdmission:()=>client.assertInventoryFence(intent.request.pathname,intent.request.method,intent.request.body,intent.request.headers,{
      ...scope,
      requestPayloadHash:intent.requestPayloadHash,
      intentId:intent.intentId,
      logicalActionKey:intent.logicalActionKey,
    }),
  };
}
async function reconcilePendingMaintenanceInventory({client,task,store,matches,payloads,journalFile,calls}){
  const target=assertSingleInventoryTarget({matches,payloads});
  const requestedScope=inventoryScopeForPayload({store,match:target.match,requestRow:target.row});
  return withInventoryCutoverLock(async()=>{
    const bundle=await readMaintenanceInventoryBundle(journalFile);
    const pending=[...(bundle?.pending?.values?.()||[])].filter(candidate=>
      String(candidate?.inventoryWriteProfile||'')===INVENTORY_MAINTENANCE_WRITE_PROFILE
      &&String(candidate?.maintenanceTaskId||'')===String(task?.id||'')
      &&inventoryRecoveryScopeKey(candidate)===inventoryRecoveryScopeKey(requestedScope));
    if(pending.length!==1){
      const error=new Error('INVENTORY_RECONCILE_PENDING_NOT_UNIQUE:count='+pending.length);
      error.code='INVENTORY_RECONCILE_PENDING_NOT_UNIQUE';
      throw error;
    }
    const intent=pending[0];
    const readback=await readbackStock(
      client,
      [{...target.match,skuCodes:[intent.skuCode]}],
      calls,
      Number(intent.targetUsableInventory),
      intent.warehouseCode,
    );
    const row=exactInventoryRow(readback,intent.skuCode);
    if(!row){
      return {state:'submitted_but_readback_pending',intent,readback,postAttempted:false};
    }
    const refreshed=await readMaintenanceInventoryBundle(journalFile);
    const stillPending=[...(refreshed?.pending?.values?.()||[])].find(candidate=>
      String(candidate?.intentId||'')===String(intent.intentId||'')
      &&String(candidate?.logicalActionKey||'')===String(intent.logicalActionKey||''));
    if(!stillPending){
      const error=new Error('INVENTORY_RECONCILE_PENDING_DRIFT:intent no longer pending');
      error.code='INVENTORY_RECONCILE_PENDING_DRIFT';
      throw error;
    }
    await appendDurableJournalRecord(String(stillPending?.journalFile||journalFile),{
      kind:'write_outcome',
      intentId:intent.intentId,
      logicalActionKey:intent.logicalActionKey,
      disposition:'readback_matched',
      recordedAt:new Date().toISOString(),
    });
    return {state:'readback_matched',intent,readback,postAttempted:false};
  });
}
function preNetworkInventoryBlock(error,{operation='update_inventory',submissionPlan=null}={}){
  const message=safeString(error?.message||error,600);
  return {name:operation,operation,path:'/open-api/stock/change-inventory/v2',method:'POST',state:'blocked',writeAttempted:false,sheinWriteAttempted:false,code:error?.code||'PRE_NETWORK_BLOCKED',msg:message,preNetwork:true,...(submissionPlan?{submissionPlanId:submissionPlan.submissionPlanId,submissionPlanIndex:submissionPlan.index,submissionPlanEndpoint:submissionPlan.endpoint,submissionPlanPayloadHash:submissionPlan.payloadBodyHash}:{})};
}
function operationSubmissionEvidence(intent,payloads,submitResults){
  const aliases=payloadAliasesForIntent(intent);
  const allPlans=payloads.map((payload,index)=>submissionPlanDescriptor(payload,index));
  const planned=allPlans.filter(row=>aliases.includes(row.operation));
  const allPlanIds=new Set(allPlans.map(row=>row.submissionPlanId));
  const plannedIds=new Set(planned.map(row=>row.submissionPlanId));
  const unknownResponses=submitResults.filter(row=>!row?.submissionPlanId||!allPlanIds.has(String(row.submissionPlanId)));
  const planMappings=planned.map(plan=>{
    const responses=submitResults.filter(row=>String(row?.submissionPlanId||'')===plan.submissionPlanId);
    const response=responses.length===1?responses[0]:null;
    const identityExact=Boolean(response
      &&Number(response.submissionPlanIndex)===plan.index
      &&String(response.operation||'')===plan.operation
      &&String(response.submissionPlanEndpoint||response.path||'')===plan.endpoint
      &&String(response.submissionPlanPayloadHash||'')===plan.payloadBodyHash);
    const accepted=Boolean(identityExact&&String(response.code)==='0'&&response.infoSuccess!==false);
    const rejected=Boolean(identityExact&&(String(response.code)!=='0'||response.infoSuccess===false));
    return {
      submissionPlanId:plan.submissionPlanId,
      index:plan.index,
      operation:plan.operation,
      endpoint:plan.endpoint,
      payloadBodyHash:plan.payloadBodyHash,
      responseCount:responses.length,
      identityExact,
      accepted,
      rejected,
      responseCode:response?.code??null,
      responseInfoSuccess:response?.infoSuccess??null,
    };
  });
  const operationResponses=submitResults.filter(row=>plannedIds.has(String(row?.submissionPlanId||''))||aliases.includes(String(row?.operation||'')));
  const accepted=planMappings.filter(row=>row.accepted);
  const rejected=planMappings.filter(row=>row.rejected);
  const missing=planMappings.filter(row=>row.responseCount===0);
  const duplicate=planMappings.filter(row=>row.responseCount>1);
  const mismatched=planMappings.filter(row=>row.responseCount===1&&!row.identityExact);
  return {
    plannedCount:planned.length,
    responseCount:operationResponses.length,
    acceptedCount:accepted.length,
    rejectedCount:rejected.length,
    missingResponseCount:missing.length,
    duplicateResponseCount:duplicate.length,
    mismatchedResponseCount:mismatched.length,
    unknownResponseCount:unknownResponses.length,
    fullySubmitted:planned.length>0
      &&unknownResponses.length===0
      &&planMappings.every(row=>row.responseCount===1&&row.identityExact&&row.accepted),
    planMappings,
    responseCodes:operationResponses.map(row=>({submissionPlanId:row.submissionPlanId||'',operation:row.operation,code:row.code??null,infoSuccess:row.infoSuccess??null})),
  };
}
function unsubmittedReadbackGroup(operation,submission){
  return {
    operation,
    ok:false,
    status:submission.rejectedCount?'operation_platform_rejected_not_read_back':'operation_not_fully_submitted',
    submitted:false,
    needsManualResolve:submission.acceptedCount>0,
    matchedRows:[],
    evidence:{submission},
  };
}
async function loadExactSpuInfoReadback(client,matches,payloads,calls){
  const candidates=[
    ...matches.map(match=>trimSpuIdentity(match?.spu)),
    ...payloads.map(row=>trimSpuIdentity(row?.body?.spu_name||row?.body?.spuName)),
  ].filter(Boolean);
  const requestedByKey=new Map();
  for(const rawSpu of candidates){
    const key=normalizeSpuIdentity(rawSpu);
    const variants=requestedByKey.get(key)||new Set();
    variants.add(rawSpu);
    requestedByKey.set(key,variants);
  }
  const cache=new Map();
  let callIndex=0;
  for(const [cacheKey,variantSet] of requestedByKey.entries()){
    const variants=[...variantSet];
    if(variants.length!==1){
      cache.set(cacheKey,{ok:false,status:'spu_info_requested_identity_case_conflict',requestedSpu:'',requestedSpuVariants:variants.sort(),returnedSpu:'',info:null,callName:''});
      continue;
    }
    const requestedSpu=variants[0];
    callIndex+=1;
    try{
      const response=await client.request(SPU_INFO_READBACK_PATH,{method:'POST',body:{spuName:requestedSpu,languageList:['en','ar']},headers:{language:'en'}});
      const call=compactCallResult(`spu-info-operation-readback-${callIndex}`,SPU_INFO_READBACK_PATH,'POST',response);
      calls.push(call);
      const info=response.data?.info;
      const returnedSpu=trimSpuIdentity(info?.spuName||info?.spu_name);
      const envelopeOk=Boolean(response.ok&&String(response.data?.code)==='0'&&info&&typeof info==='object');
      const ok=Boolean(envelopeOk&&returnedSpu===requestedSpu);
      const status=ok?'spu_info_identity_exact':(envelopeOk&&returnedSpu&&normalizeSpuIdentity(returnedSpu)===cacheKey?'spu_info_return_identity_case_mismatch':'spu_info_query_or_identity_failed');
      cache.set(cacheKey,{ok,status,requestedSpu,requestedSpuVariants:variants,returnedSpu,info:info&&typeof info==='object'?info:null,callName:call.name});
    }catch(error){
      const call={name:`spu-info-operation-readback-${callIndex}`,path:SPU_INFO_READBACK_PATH,method:'POST',httpStatus:null,code:null,msg:safeString(error?.message||error,300),traceId:null};
      calls.push(call);
      cache.set(cacheKey,{ok:false,status:'spu_info_query_exception',requestedSpu,requestedSpuVariants:variants,returnedSpu:'',info:null,callName:call.name});
    }
  }
  return cache;
}
function readbackShelfOperation(operation,payloads,matches,cache,submission){
  if(!submission.fullySubmitted) return unsubmittedReadbackGroup(operation,submission);
  const plans=payloads.filter(row=>row.operation===operation);
  const targets=[];
  for(const plan of plans){
    for(const row of asArray(plan?.body?.skc_site_info_list)){
      const skc=String(row?.skc_name||'').trim();
      const requestedShelfState=Number(row?.shelf_state);
      const expectedShelfStatus=requestedShelfState===1?'1':requestedShelfState===2?'0':'';
      for(const site of asArray(row?.site_list)){
        const match=matchForExactSkc(matches,skc);
        const entry=match?exactSpuEntry(cache,match.spu):null;
        const skcRows=entry?.ok?exactSkcRows(entry.info,skc):[];
        const siteRows=skcRows.length===1?exactSiteRows(skcRows[0],site):[];
        const actualShelfStatus=siteRows.length===1?String(siteRows[0]?.shelfStatus??siteRows[0]?.shelf_status??''):'';
        const ok=Boolean(expectedShelfStatus&&match&&entry?.ok&&skcRows.length===1&&siteRows.length===1&&actualShelfStatus===expectedShelfStatus);
        targets.push({spu:trimSpuIdentity(match?.spu),skc,site:String(site||''),requestedShelfState:Number.isInteger(requestedShelfState)?requestedShelfState:null,expectedShelfStatus,actualShelfStatus,spuIdentityStatus:entry?.status||'spu_info_not_found',requestedSpu:entry?.requestedSpu||'',returnedSpu:entry?.returnedSpu||'',identityExact:Boolean(match&&entry?.ok&&skcRows.length===1),fieldPresent:siteRows.length===1&&actualShelfStatus!=='',ok});
      }
    }
  }
  const ok=targets.length>0&&targets.every(row=>row.ok);
  return {operation,ok,status:ok?'matched_shelf_status_exact':'shelf_status_readback_mismatch',submitted:true,needsManualResolve:!ok,matchedRows:ok?targets:[],evidence:{submission,sourceEndpoint:SPU_INFO_READBACK_PATH,targets}};
}
function readbackSupplyPriceOperation(payloads,cache,submission){
  const operation='update_supply_price';
  if(!submission.fullySubmitted) return unsubmittedReadbackGroup(operation,submission);
  const plans=payloads.filter(row=>row.operation===operation);
  const targets=[];
  for(const plan of plans){
    const spu=trimSpuIdentity(plan?.body?.spu_name||plan?.body?.spuName);
    const entry=exactSpuEntry(cache,spu);
    for(const skcPlan of asArray(plan?.body?.skc_info_list)){
      const skc=String(skcPlan?.skc_name||'').trim();
      const skcRows=entry?.ok?exactSkcRows(entry.info,skc):[];
      for(const skuPlan of asArray(skcPlan?.sku_info_list)){
        const sku=String(skuPlan?.sku_code||'');
        const expectedCurrency=String(skuPlan?.currency||'').trim().toUpperCase();
        const expectedCost=canonicalDecimal(skuPlan?.cost);
        const skuRows=skcRows.length===1?exactSkuRows(skcRows[0],sku):[];
        const costs=skuRows.length===1?asArray(skuRows[0]?.costInfoList||skuRows[0]?.cost_info_list):[];
        const currencyRows=costs.filter(row=>String(row?.currency||'').trim().toUpperCase()===expectedCurrency);
        const actualCurrency=currencyRows.length===1?String(currencyRows[0]?.currency||'').trim().toUpperCase():'';
        const actualCost=currencyRows.length===1?canonicalDecimal(currencyRows[0]?.costPrice??currencyRows[0]?.cost_price):null;
        const ok=Boolean(spu&&entry?.ok&&skcRows.length===1&&skuRows.length===1&&expectedCurrency&&expectedCost!==null&&currencyRows.length===1&&actualCurrency===expectedCurrency&&actualCost===expectedCost);
        targets.push({spu,skc,sku,expectedCurrency,actualCurrency,expectedCost,actualCost,skcMatchCount:skcRows.length,skuMatchCount:skuRows.length,currencyMatchCount:currencyRows.length,ok});
      }
    }
  }
  const ok=targets.length>0&&targets.every(row=>row.ok);
  return {operation,ok,status:ok?'matched_supply_price_exact':'supply_price_readback_mismatch',submitted:true,needsManualResolve:!ok,matchedRows:ok?targets:[],evidence:{submission,sourceEndpoint:SPU_INFO_READBACK_PATH,numericPolicy:'canonical-decimal-exact-no-tolerance',targets}};
}
function compareRequestedTitles(expectedRows,liveRows){
  const expected=asArray(expectedRows).map(row=>({language:String(row?.language||'').trim().toLowerCase(),text:String(row?.name??'')}));
  const live=asArray(liveRows).map(row=>({language:String(row?.language||'').trim().toLowerCase(),text:String(row?.productName??row?.product_name??row?.name??'')}));
  const expectedLanguages=expected.map(row=>row.language);
  const duplicateExpected=expectedLanguages.some((language,index)=>!language||expectedLanguages.indexOf(language)!==index);
  const comparisons=expected.map(row=>{
    const candidates=live.filter(item=>item.language===row.language);
    return {language:row.language,expectedText:row.text,actualTexts:candidates.map(item=>item.text),ok:Boolean(row.language&&row.text&&candidates.length===1&&candidates[0].text===row.text)};
  });
  return {ok:expected.length>0&&!duplicateExpected&&comparisons.every(row=>row.ok),duplicateExpected,comparisons};
}
function readbackTitleOperation(payloads,cache,submission){
  const operation='update_title';
  if(!submission.fullySubmitted) return unsubmittedReadbackGroup(operation,submission);
  const plans=payloads.filter(row=>payloadAliasesForIntent(operation).includes(row.operation));
  const targets=[];
  for(const plan of plans){
    const body=plan?.body||{};
    const spu=trimSpuIdentity(body.spu_name||body.spuName);
    const entry=exactSpuEntry(cache,spu);
    const expected=asArray(body.multi_language_name_list||body.multiLanguageNameList);
    const spuComparison=entry?.ok?compareRequestedTitles(expected,entry.info?.productMultiNameList||entry.info?.product_multi_name_list):{ok:false,duplicateExpected:false,comparisons:[]};
    const skcComparisons=[];
    for(const skcPlan of asArray(body.skc_list||body.skcList)){
      const skc=String(skcPlan?.skc_name||skcPlan?.skcName||'').trim();
      const rows=entry?.ok?exactSkcRows(entry.info,skc):[];
      const comparison=rows.length===1?compareRequestedTitles(expected,rows[0]?.productMultiNameList||rows[0]?.product_multi_name_list):{ok:false,duplicateExpected:false,comparisons:[]};
      skcComparisons.push({skc,identityExact:rows.length===1,...comparison});
    }
    const ok=Boolean(spu&&entry?.ok&&spuComparison.ok&&skcComparisons.length>0&&skcComparisons.every(row=>row.ok));
    targets.push({spu,identityExact:Boolean(entry?.ok),spuTitles:spuComparison,skcTitles:skcComparisons,ok});
  }
  const ok=targets.length>0&&targets.every(row=>row.ok);
  return {operation,ok,status:ok?'matched_title_exact':'title_readback_mismatch',submitted:true,needsManualResolve:!ok,matchedRows:ok?targets:[],evidence:{submission,sourceEndpoint:SPU_INFO_READBACK_PATH,textPolicy:'language-keyed-byte-exact-for-every-requested-language',targets}};
}
function canonicalSiteListFromRequest(group){ return unique(asArray(group?.site_abbr_list||group?.siteAbbrList).map(value=>String(value||'').trim().toLowerCase()).filter(Boolean)).sort(); }
function canonicalSiteListFromLive(group){
  return unique(asArray(group?.siteInfoList||group?.site_info_list||group?.siteList||group?.site_list)
    .map(row=>String(row?.site??row?.siteAbbr??row?.site_abbr??'').trim().toLowerCase()).filter(Boolean)).sort();
}
function compareSiteDetailGroupsExact(expectedGroups,liveGroups){
  const expected=asArray(expectedGroups).map(group=>({sites:canonicalSiteListFromRequest(group),rows:asArray(group?.image_info_list||group?.imageInfoList)}));
  const live=asArray(liveGroups).map(group=>({sites:canonicalSiteListFromLive(group),rows:asArray(group?.imageInfoList||group?.image_info_list)}));
  const comparisons=expected.map(group=>{
    const candidates=live.filter(item=>stableJson(item.sites)===stableJson(group.sites));
    const imageComparison=candidates.length===1?compareImageRowsExact(group.rows,candidates[0].rows,{siteDetail:true}):{ok:false,expected:[],actual:[],urlPolicy:IMAGE_URL_READBACK_POLICY};
    return {sites:group.sites,groupMatchCount:candidates.length,...imageComparison,ok:group.sites.length>0&&candidates.length===1&&imageComparison.ok};
  });
  return {ok:expected.length>0&&comparisons.every(row=>row.ok)&&expected.length===live.length,expectedGroupCount:expected.length,liveGroupCount:live.length,comparisons};
}
function readbackImagesOperation(payloads,cache,submission){
  const operation='update_images';
  if(!submission.fullySubmitted) return unsubmittedReadbackGroup(operation,submission);
  const plans=payloads.filter(row=>payloadAliasesForIntent(operation).includes(row.operation));
  const levels=[];
  for(const plan of plans){
    const body=plan?.body||{};
    const spu=trimSpuIdentity(body.spu_name||body.spuName);
    const entry=exactSpuEntry(cache,spu);
    if(body.image_info||body.imageInfo){
      const comparison=entry?.ok
        ?compareImageRowsExact(imageInfoRows(body.image_info||body.imageInfo),entry.info?.spuImageInfoList||entry.info?.spu_image_info_list)
        :{ok:false,expected:[],actual:[],urlPolicy:IMAGE_URL_READBACK_POLICY};
      levels.push({level:'SPU',spu,identityExact:Boolean(entry?.ok),...comparison});
    }
    if(body.site_detail_image_info_list||body.siteDetailImageInfoList){
      levels.push({level:'INVALID_TOP_LEVEL_SITE_DETAIL',spu,identityExact:Boolean(entry?.ok),ok:false,reason:'partialEdit official schema binds site_detail_image_info_list under an exact SKC, not SPU'});
    }
    for(const skcPlan of asArray(body.skc_list||body.skcList)){
      const skc=String(skcPlan?.skc_name||skcPlan?.skcName||'').trim();
      const skcRows=entry?.ok?exactSkcRows(entry.info,skc):[];
      const skcInfo=skcRows.length===1?skcRows[0]:null;
      if(skcPlan?.image_info||skcPlan?.imageInfo){
        const comparison=skcInfo
          ?compareImageRowsExact(imageInfoRows(skcPlan.image_info||skcPlan.imageInfo),skcInfo?.skcImageInfoList||skcInfo?.skc_image_info_list)
          :{ok:false,expected:[],actual:[],urlPolicy:IMAGE_URL_READBACK_POLICY};
        levels.push({level:'SKC',spu,skc,identityExact:Boolean(entry?.ok&&skcInfo),...comparison});
      }
      if(skcPlan?.site_detail_image_info_list||skcPlan?.siteDetailImageInfoList){
        const comparison=skcInfo
          ?compareSiteDetailGroupsExact(skcPlan.site_detail_image_info_list||skcPlan.siteDetailImageInfoList,skcInfo?.siteDetailImageInfoList||skcInfo?.site_detail_image_info_list)
          :{ok:false,expectedGroupCount:asArray(skcPlan.site_detail_image_info_list||skcPlan.siteDetailImageInfoList).length,liveGroupCount:0,comparisons:[]};
        levels.push({level:'SKC_SITE_DETAIL',spu,skc,identityExact:Boolean(entry?.ok&&skcInfo),...comparison});
      }
      for(const skuPlan of asArray(skcPlan?.sku_list||skcPlan?.skuList)){
        if(!skuPlan?.image_info&&!skuPlan?.imageInfo) continue;
        const sku=String(skuPlan?.sku_code||skuPlan?.skuCode||'');
        const skuRows=skcInfo?exactSkuRows(skcInfo,sku):[];
        const skuInfo=skuRows.length===1?skuRows[0]:null;
        const comparison=skuInfo
          ?compareImageRowsExact(imageInfoRows(skuPlan.image_info||skuPlan.imageInfo),skuInfo?.skuImageInfoList||skuInfo?.sku_image_info_list)
          :{ok:false,expected:[],actual:[],urlPolicy:IMAGE_URL_READBACK_POLICY};
        levels.push({level:'SKU',spu,skc,sku,identityExact:Boolean(entry?.ok&&skcInfo&&skuInfo),...comparison});
      }
    }
  }
  const ok=levels.length>0&&levels.every(row=>row.ok);
  return {operation,ok,status:ok?'matched_images_exact':'image_readback_mismatch',submitted:true,needsManualResolve:!ok,matchedRows:ok?levels:[],evidence:{submission,sourceEndpoint:SPU_INFO_READBACK_PATH,urlPolicy:IMAGE_URL_READBACK_POLICY,levels}};
}
function readbackProductPriceUnconfirmed(submission){
  return {
    operation:'update_product_price',
    ok:false,
    status:'product_price_unconfirmed',
    submitted:submission.acceptedCount>0,
    needsManualResolve:true,
    matchedRows:[],
    evidence:{submission,identityOnlyAccepted:false,reason:'No repository-proven operation-specific authoritative read field is approved for update_product_price; product/query identity is not mutation proof.'},
  };
}
function stockRowWarehouseCode(row,...parents){
  return safeString(row?.warehouseCode||row?.warehouse_code||row?.warehouseNo||row?.warehouse_no||row?.warehouse||parents.find(Boolean)||'',120).toUpperCase();
}
function inventoryInteger(value){
  if(value===undefined||value===null||value==='') return null;
  const n=Number(value);
  return Number.isSafeInteger(n)&&n>=0?n:null;
}
function normalizedInventoryFields({total,usable,locked,tempLocked}){
  const fields={
    totalInventoryQuantity:inventoryInteger(total),
    totalUsableInventory:inventoryInteger(usable),
    totalLockedQuantity:inventoryInteger(locked),
    temporaryInventoryQuantity:inventoryInteger(tempLocked),
  };
  return {...fields,inventoryFieldsValid:Object.values(fields).every(Number.isSafeInteger)};
}
async function readbackStock(client, matches, calls, expectedInventory, expectedWarehouseCode=''){
  const skuCodes=unique(matches.flatMap(m=>m.skuCodes));
  if(!skuCodes.length) return {ok:false,status:'missing_sku_codes',matchedRows:[],calls};
  const response=await client.request('/open-api/stock/stock-query',{method:'POST',body:{skuCodeList:skuCodes,warehouseType:'2',invType:'VI'},headers:{language:'en'}});
  calls.push(compactCallResult('stock-query-readback','/open-api/stock/stock-query','POST',response));
  if(String(response.data?.code)!=='0') return {ok:false,status:'stock_query_failed',skuCodes:skuCodes.slice(0,100),matchedRows:[],calls};
  const expectedWarehouse=safeString(expectedWarehouseCode,120).toUpperCase();
  const rows=asArray(response.data?.info).flatMap(info=>asArray(info?.goodsInventory).flatMap(group=>{
    const groupWarehouse=stockRowWarehouseCode(group,info?.warehouseCode,info?.warehouse_code);
    return asArray(group?.skuList).flatMap(row=>{
      const nested=asArray(row?.warehouseInventoryList||row?.warehouse_inventory_list);
      if(nested.length){
        return nested.map(warehouseRow=>({
          ...row,
          warehouseCode: stockRowWarehouseCode(warehouseRow,groupWarehouse),
          ...normalizedInventoryFields({
            total:warehouseRow?.inventoryQuantity??warehouseRow?.inventory_quantity??warehouseRow?.totalInventoryQuantity??warehouseRow?.total_inventory_quantity,
            usable:warehouseRow?.usableInventory??warehouseRow?.usable_inventory??warehouseRow?.totalUsableInventory??warehouseRow?.total_usable_inventory,
            locked:warehouseRow?.lockedQuantity??warehouseRow?.locked_quantity??warehouseRow?.totalLockedQuantity??warehouseRow?.total_locked_quantity,
            tempLocked:warehouseRow?.tempLockQuantity??warehouseRow?.temp_lock_quantity??warehouseRow?.totalTempLockQuantity??warehouseRow?.total_temp_lock_quantity??warehouseRow?.temporaryInventoryQuantity??warehouseRow?.temporary_inventory_quantity,
          }),
        }));
      }
      return [{
        ...row,
        warehouseCode: stockRowWarehouseCode(row,groupWarehouse),
        ...normalizedInventoryFields({
          total:row?.totalInventoryQuantity??row?.total_inventory_quantity??row?.inventoryQuantity??row?.inventory_quantity,
          usable:row?.totalUsableInventory??row?.total_usable_inventory??row?.usableInventory??row?.usable_inventory,
          locked:row?.totalLockedQuantity??row?.total_locked_quantity??row?.lockedInventory??row?.locked_inventory,
          tempLocked:row?.totalTempLockQuantity??row?.total_temp_lock_quantity??row?.temporaryInventoryQuantity??row?.temporary_inventory_quantity??row?.temporaryLockedQuantity??row?.temporary_locked_quantity,
        }),
      }];
    });
  }));
  const rowsForScope=expectedWarehouse?rows.filter(row=>row.warehouseCode===expectedWarehouse):rows;
  const missingSkuCodes=skuCodes.filter(sku=>!rowsForScope.some(row=>String(row?.skuCode||'')===sku));
  const ambiguousSkuCodes=skuCodes.filter(sku=>rowsForScope.filter(row=>String(row?.skuCode||'')===sku).length>1);
  const wrongWarehouseSkuCodes=expectedWarehouse?skuCodes.filter(sku=>rows.some(row=>String(row?.skuCode||'')===sku)&&!rowsForScope.some(row=>String(row?.skuCode||'')===sku)):[];
  const invalidInventorySkuCodes=skuCodes.filter(sku=>rowsForScope.some(row=>String(row?.skuCode||'')===sku&&row?.inventoryFieldsValid!==true));
  const mismatchedSkuCodes=Number.isFinite(expectedInventory)
    ? skuCodes.filter(sku=>{
      const row=rowsForScope.find(item=>String(item?.skuCode||'')===sku);
      return row && Number(row.totalUsableInventory)!==Number(expectedInventory);
    })
    : [];
  const ok=missingSkuCodes.length===0&&ambiguousSkuCodes.length===0&&wrongWarehouseSkuCodes.length===0&&invalidInventorySkuCodes.length===0&&mismatchedSkuCodes.length===0;
  return {ok,status:ok?'matched_stock_query_exact':'stock_query_readback_mismatch',skuCodes:skuCodes.slice(0,100),missingSkuCodes,ambiguousSkuCodes,wrongWarehouseSkuCodes,invalidInventorySkuCodes,mismatchedSkuCodes,expectedWarehouseCode:expectedWarehouse||null,expectedInventory:Number.isFinite(expectedInventory)?expectedInventory:null,matchedRows:ok?matches.slice(0,20):[],rows:rowsForScope,calls};
}
async function readbackForIntents(client, intents, matches, calls, expectedInventory, task, descriptionBeforePreflight = null, submittedDescriptionVersion = '', payloads = [], submitResults = []){
  const groups=[];
  const operationIntents=unique(intents);
  const submissions=new Map(operationIntents.map(intent=>[intent,operationSubmissionEvidence(intent,payloads,submitResults)]));
  const spuInfoIntents=operationIntents.filter(intent=>submissions.get(intent)?.fullySubmitted&&['activate_link','retire_link','update_supply_price','update_title','update_images'].includes(intent));
  const spuInfoCache=spuInfoIntents.length?await loadExactSpuInfoReadback(client,matches,payloads,calls):new Map();
  for(const intent of operationIntents){
    const submission=submissions.get(intent);
    if(intent==='activate_link'||intent==='retire_link') groups.push(readbackShelfOperation(intent,payloads,matches,spuInfoCache,submission));
    else if(intent==='update_inventory'){
      if(!submission.fullySubmitted) groups.push(unsubmittedReadbackGroup(intent,submission));
      else {
        const expectedWarehouseCode=safeString(submitResults.find(row=>row?.operation==='update_inventory')?.inventoryIntent?.warehouseCode||'',120);
        groups.push({operation:intent,...await readbackStock(client,matches,calls,expectedInventory,expectedWarehouseCode),submitted:true,evidence:{submission,sourceEndpoint:'/open-api/stock/stock-query',expectedInventory:Number.isFinite(expectedInventory)?expectedInventory:null,expectedWarehouseCode:expectedWarehouseCode||null}});
      }
    }
    else if(intent==='update_supply_price') groups.push(readbackSupplyPriceOperation(payloads,spuInfoCache,submission));
    else if(intent==='update_product_price') groups.push(submission.fullySubmitted?readbackProductPriceUnconfirmed(submission):unsubmittedReadbackGroup(intent,submission));
    else if(intent==='update_title') groups.push(readbackTitleOperation(payloads,spuInfoCache,submission));
    else if(intent==='update_images') groups.push(readbackImagesOperation(payloads,spuInfoCache,submission));
    else if(intent==='update_description'){
      if(!submission.fullySubmitted) groups.push(unsubmittedReadbackGroup(intent,submission));
      else {
        const descriptionReadback=await readbackUpdateDescription(client,task,matches,calls,descriptionBeforePreflight,submittedDescriptionVersion);
        groups.push({operation:intent,...descriptionReadback,submitted:true,submission});
      }
    }
    else if(intent==='certificate_review') groups.push(submission.fullySubmitted
      ?{operation:intent,ok:false,status:'certificate_submitted_manual_review_required',submitted:true,needsManualResolve:true,matchedRows:[],evidence:{submission},warnings:['证书/资质提交后需人工确认平台审核状态，不能自动判成功。']}
      :unsubmittedReadbackGroup(intent,submission));
  }
  if(!groups.length) return {ok:false,status:'not_run',matchedRows:[],calls};
  const ok=groups.every(g=>g.ok);
  const matchedRows=groups.flatMap(g=>Array.isArray(g.matchedRows)?g.matchedRows:[]);
  return {ok,status:groups.map(g=>g.status).join('+'),matchedRows,groups,calls};
}
async function main(){
  const args=parseArgs(process.argv.slice(2)); const startedAt=new Date().toISOString(); const runId=`lmo_${nowId()}_${crypto.randomBytes(4).toString('hex')}`; const {task, executionContext}=await loadTask(args); const store=args.store||taskStores(task)[0]; if(!store) throw new Error('Missing --store / task store'); const inventoryJournalFile=inventoryJournalFileForMaintenanceTask(args,{task,store}); args.inventoryJournalFile=inventoryJournalFile; const intents=taskIntents(task); const blockers=[]; const warnings=[]; const calls=[];
  if(!intents.length) blockers.push('任务不包含维护写动作。');
  if(intents.includes('update_description')&&(intents.length!==1||intents[0]!=='update_description')){
    blockers.push('历史描述回填任务必须单独 update_description，不能混入其他维护动作。');
  }
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
  const explicitSpu=intents.includes('update_description')?String(structuredTaskParameters(task).spuName||'').trim():'';
  let resolved;
  if(explicitSpu&&/^[A-Za-z][A-Za-z0-9_-]{3,}$/.test(explicitSpu)){
    resolved={
      refs:[explicitSpu],
      matches:[{
        ref:explicitSpu,storeKey:store,skc:'',spu:explicitSpu,standardGoodsSn:'',
        isOnShelf:null,skuCodes:[],supplierCode:'',costSar:null,sheinUsableInventory:0,
        productRowFound:false,resolvedFrom:'task_explicit_spu_identity',
      }],
      missing:[],
    };
    warnings.push(`update_description 使用任务参数锁定的显式 SPU 身份 ${explicitSpu}；不依赖旧链接快照解析。`);
  } else {
    const snapshotResolved=resolveTargets({task, store, linkRows:linkLoad.rows||[], productRows:productLoad.rows||[]});
    const boundResolved=intents.includes('update_images')
      ? resolveApprovedImageBindingIdentity(task,store,snapshotResolved.missing,warnings)
      : {matches:[],unresolved:snapshotResolved.missing};
    const liveResolved=await resolveMissingExactSkcsFromOpenApi(client,store,boundResolved.unresolved,calls,warnings);
    const mergedMatches=[]; const mergedKeys=new Set();
    for(const match of [...snapshotResolved.matches,...boundResolved.matches,...liveResolved.matches]){ const key=`${match.storeKey}|${normalizeSheinSkc(match.skc)||compactRef(match.skc)}|${compactRef(match.spu)}`; if(mergedKeys.has(key)) continue; mergedKeys.add(key); mergedMatches.push(match); }
    resolved={refs:snapshotResolved.refs,matches:mergedMatches,missing:liveResolved.unresolved};
  }
  if(resolved.missing.length) blockers.push(`未定位到目标货号/SKC：${resolved.missing.join('、')}`);
  if(!resolved.matches.length) blockers.push('没有可执行目标链接。');
  const correctionValidation=intents.includes('update_images')
    ?validatePendingListingImageCorrection(task,{store})
    :{present:false,ok:false,blockers:[],correction:null};
  if(correctionValidation.present&&!correctionValidation.ok) blockers.push(...correctionValidation.blockers);
  if(correctionValidation.present&&(intents.length!==1||intents[0]!=='update_images')) blockers.push('待审核新品纠图计划只能单独执行 update_images，不能混入其他维护动作。');
  const correction=correctionValidation.ok?correctionValidation.correction:null;
  let correctionStateBefore=null;
  if(correction){
    const stateProbe=await queryPendingCorrectionDocumentState(client,correction,calls);
    if(!stateProbe.ok) blockers.push(`待审核新品纠图无法精确回读审核状态：${safeString(stateProbe.reason,300)}`);
    else if(![1,4].includes(stateProbe.documentState)) blockers.push(`待审核新品纠图仅允许从待审核(1)或已撤回(4)继续；当前 documentState=${stateProbe.documentState}`);
    else correctionStateBefore=stateProbe.documentState;
  }
  const imageEditPayloads=intents.includes('update_images')
    ? normalizeImageEditPayloadsFromJsonAssets(taskWithJsonAssets,resolved.matches,warnings)
    : [];
  const imagePayloadInspection=intents.includes('update_images')
    ? inspectImageEditPayloads(imageEditPayloads,blockers,warnings)
    : inspectImageEditPayloads([],blockers,warnings);
  const certificatePayloads=normalizeCertificatePayloadsFromJsonAssets(taskWithJsonAssets,warnings);
  const spuInfoMap=intents.includes('update_images')&&!correction
    ? await fetchSpuInfoForImages(client,resolved.matches,calls,warnings,blockers)
    : new Map();
  const payloads=correction&&correctionStateBefore!==null
    ?[
      ...(correctionStateBefore===1?[{operation:'pending_new_listing_revoke',endpoint:'/open-api/goods/revoke-product',body:{spuName:correction.identity.spuName},targetLinks:resolved.matches}]:[]),
      {operation:'pending_new_listing_republish',endpoint:'/open-api/goods/product/publishOrEdit',body:correction.republishPayload,targetLinks:resolved.matches},
    ]
    :await buildPayloads({task:taskWithJsonAssets,intents,matches:resolved.matches,siteInfo,blockers,warnings,imageEditPayloads,certificatePayloads,spuInfoMap,inventoryWarehouseCode});
  let descriptionPreflight=null;
  const descriptionUpdatePayloadPlan=payloads.find(p=>p.operation==='update_description')||null;
  if(intents.includes('update_description')){
    descriptionPreflight=await runUpdateDescriptionLivePreflight(client,task,resolved.matches,calls,blockers);
  }
  const descriptionAlreadyMatched = intents.includes('update_description')
    && descriptionPreflight
    && DESCRIPTION_PUBLISH_LANGUAGES.every(language => {
      const expected = String(task?.descriptionMaterialBinding?.hashes?.[language] || '').toLowerCase();
      const live = String(descriptionPreflight.currentDescriptionHashes?.[language] || '').toLowerCase();
      return Boolean(expected) && live === expected;
    });
  if (descriptionAlreadyMatched) {
    warnings.push('live 商品描述已与审核资料目标逐字一致（already_matched）：无需写入，不能用作提交证明。');
  }
  const descriptionSummary=descriptionUpdatePayloadPlan
    ? {spuName:String(descriptionUpdatePayloadPlan.body?.spu_name||''),payloadHash:sha256Stable(descriptionUpdatePayloadPlan.body),descriptionCount:asArray(descriptionUpdatePayloadPlan.body?.multi_language_desc_list).length}
    : null;
  const submitPlanFull={
    storeKey:store,
    intents,
    ...(correction?{pendingNewListingImageCorrection:{correctionFingerprint:correction.correctionFingerprint,sourceTaskId:correction.sourceTaskId,documentVersion:correction.documentVersion,documentStateBefore:correctionStateBefore}}:{}),
    payloads:payloads.map(p=>({operation:p.operation,endpoint:p.endpoint,body:p.body,targetSkcs:p.targetLinks.map(x=>x.skc).filter(Boolean)})),
  };
  // Persisted submitPlan never contains description body text (hash/count only
  // for update_description); the full body lives only in process memory and is
  // used solely to compute the locked payload hash and the guarded write call.
  const submitPlan=projectSubmitPlanForPersistence(submitPlanFull);
  const payloadHash=payloads.some(p=>Object.keys(p.body||{}).length)?sha256Stable(submitPlanFull):'';
  let writeClaimEvidence=null;
  let submitResults=[]; let actualWriteSubmitted=false; let writeAttempted=false; let recoveryRequired=false; let correctionReadback=null; let correctionPublishResult=null;
  if(args.reconcilePendingOnly){
    if(intents.length!==1||intents[0]!=='update_inventory') blockers.push('--reconcile-pending-only 仅允许单一 update_inventory 任务。');
    if(blockers.length===0){
      try{
        const reconciliation=await reconcilePendingMaintenanceInventory({
          client,task,store,matches:resolved.matches,payloads,journalFile:inventoryJournalFile,calls,
        });
        const reconciled=reconciliation.state==='readback_matched';
        const output={
          ok:reconciled,
          runId,
          mode:'reconcile-pending-only',
          adapterKind:'link_maintenance_openapi_executor',
          state:reconciliation.state,
          outcome:reconciled?'completed':'unconfirmed',
          committed:false,
          partial:!reconciled,
          startedAt,
          endedAt:new Date().toISOString(),
          storeKey:store,
          task:{id:task.id||'',status:task.status||'',intents,productRefs:taskProductRefs(task)},
          payload:{found:Boolean(payloadHash),payloadHash},
          adapterEvidence:{realSubmit:false,writeAttempted:false,sheinWriteAttempted:false,recoveryRequired:!reconciled,postAttempted:false,inventoryIntent:{intentId:reconciliation.intent?.intentId||'',logicalActionKey:reconciliation.intent?.logicalActionKey||'',journalFile:rel(inventoryJournalFile)},calls},
          publishResult:null,
          readback:reconciliation.readback,
          blockers:reconciled?[]:['库存 fresh readback 尚未匹配旧 pending intent 的目标；保持 pending，未发送库存 POST。'],
          warnings:[],
          safety:{canSilentWrite:false,reconcileOnly:true,inventoryPostForbidden:true},
        };
        const outPath=path.join(args.outDir,`${runId}.local.json`);
        await writeJson(outPath,output);
        output.savedTo=rel(outPath);
        if(!args.quiet) console.log(JSON.stringify(output,null,2));
        return;
      }catch(error){
        const output={ok:false,runId,mode:'reconcile-pending-only',adapterKind:'link_maintenance_openapi_executor',state:'blocked',outcome:'blocked',committed:false,partial:false,startedAt,endedAt:new Date().toISOString(),storeKey:store,task:{id:task.id||'',status:task.status||'',intents,productRefs:taskProductRefs(task)},adapterEvidence:{realSubmit:false,writeAttempted:false,sheinWriteAttempted:false,recoveryRequired:false,postAttempted:false,calls},publishResult:null,readback:{ok:false,status:'reconcile_blocked',calls:[]},blockers:[safeString(error?.message||error,800)],warnings:[],safety:{canSilentWrite:false,reconcileOnly:true,inventoryPostForbidden:true}};
        const outPath=path.join(args.outDir,`${runId}.local.json`);
        await writeJson(outPath,output);
        output.savedTo=rel(outPath);
        if(!args.quiet) console.log(JSON.stringify(output,null,2));
        return;
      }
    }
  }
  if(args.mode==='execute'){
    const expected=safeString(executionContext?.expectedPayloadHash||executionContext?.request?.expectedPayloadHash||executionContext?.request?.payloadHash||'',120);
    if(args.confirm!==SUBMIT_CONFIRM_TEXT) blockers.push(`真实提交必须显式传入 --confirm ${SUBMIT_CONFIRM_TEXT}`);
    if(!expected) blockers.push('真实提交缺少 dry-run 锁定的 payload hash。');
    else if(!payloadHash||payloadHash!==expected) blockers.push(`真实提交 payload hash 与 dry-run 锁定值不一致：expected=${expected||'missing'} actual=${payloadHash||'missing'}`);
    const claim=executionContext?.writeClaim||null;
    const claimNonce=String(args.claimNonce||'');
    const expectedClaimOperations=unique(intents.map(value=>String(value||'').trim().toLowerCase())).sort();
    const actualClaimOperations=unique(asArray(claim?.operations||claim?.intents||[]).map(value=>String(value||'').trim().toLowerCase())).sort();
    const claimOk=Boolean(claim&&claimNonce
      &&String(claim?.nonce||'')===claimNonce
      &&String(claim?.taskId||'')===String(task?.id||'')
      &&normalizeStoreKey(claim?.storeKey||'')===normalizeStoreKey(store)
      &&String(claim?.expectedPayloadHash||'')===payloadHash
      &&String(claim?.state||'')==='claimed'
      &&JSON.stringify(actualClaimOperations)===JSON.stringify(expectedClaimOperations));
    if(!claimOk){
      blockers.push('维护真实提交缺少服务端持久化 write-claim（nonce/taskId/store/state/expectedPayloadHash/operations 必须全部精确一致），禁止调用 SHEIN 写接口。');
    }else{
      // Preserve proof that this process validated the durable server claim,
      // but never echo the one-time nonce into logs or persisted output.
      writeClaimEvidence={
        validated:true,
        schemaVersion:Number(claim?.schemaVersion||1),
        claimId:safeString(claim?.claimId||'',160),
        taskId:String(claim?.taskId||''),
        storeKey:normalizeStoreKey(claim?.storeKey||''),
        operations:actualClaimOperations,
        expectedPayloadHash:String(claim?.expectedPayloadHash||''),
        claimedAt:safeString(claim?.claimedAt||'',80),
        claimedBy:safeString(claim?.claimedBy||'',160),
        state:String(claim?.state||''),
        nonceValidated:true,
      };
    }
    if(intents.includes('update_description')){
      const baseline=descriptionPreflightFromTaskExecution(task,store);
      if(!baseline?.currentDescriptionHashes){
        blockers.push('update_description 执行前缺少 dry-run 基线描述 hash，禁止提交。');
      }else if(descriptionPreflight){
        for(const language of ['ar','en']){
          const live=String(descriptionPreflight.currentDescriptionHashes?.[language]||'');
          const expected=String(baseline.currentDescriptionHashes?.[language]||'');
          if(expected&&live&&live!==expected){
            blockers.push(`update_description 执行前 live ${language} 描述已漂移（dry-run=${expected} live=${live}），禁止提交。`);
          }
        }
      }
    }
  }
  const taskParameters=structuredTaskParameters(task);
  const hasExpectedCurrentInventory=taskParameters.expectedCurrentInventory!==undefined
    && taskParameters.expectedCurrentInventory!==null
    && taskParameters.expectedCurrentInventory!=='';
  const expectedCurrentInventory=hasExpectedCurrentInventory
    ? Number(taskParameters.expectedCurrentInventory)
    : null;
  let inventoryPreflight=null;
  if(blockers.length===0&&intents.includes('update_inventory')){
    if(hasExpectedCurrentInventory&&(!Number.isInteger(expectedCurrentInventory)||expectedCurrentInventory<0)){
      blockers.push(`库存写前漂移门禁的 expectedCurrentInventory 非法：${taskParameters.expectedCurrentInventory}`);
    }else{
      try{
        assertSingleInventoryTarget({matches:resolved.matches,payloads});
      }catch(error){
        blockers.push(safeString(error?.message||error,500));
      }
    }
  }
  if(args.mode==='execute' && blockers.length===0){
    if (intents.includes('update_description') && descriptionAlreadyMatched) {
      // No-op: live content already equals the target; skipping the write
      // entirely. already_matched must never be presented as submission
      // evidence.
      writeAttempted=false;
    } else {
      let payloadIndex=0;
      for(const p of payloads){
        const submissionPlan=submissionPlanDescriptor(p,payloadIndex);
        payloadIndex+=1;
        if(p.operation==='update_inventory'){
          const rows=asArray(p.body?.updateSkuInventoryQuantityRequests);
          for(const row of rows){
            const match=p.targetLinks.find(item=>asArray(item?.skuCodes).map(String).includes(String(row?.skuCode||''))) || p.targetLinks[0] || {};
            const authorizationId=String(executionContext?.writeClaim?.claimId||executionContext?.writeClaim?.claimedBy||task?.id||runId||'link-ops-maintenance');
            let durablePrepared=null;
            let guardedWrite=null;
            try{
              guardedWrite=await runSheinWebhookExternalWriteGuarded({
                writeStores:[store],
                guard:testWebhookGuard||undefined,
                write:()=>submitDurableInventoryWriteOnce({
                  journalFile:inventoryJournalFile,
                  intent:null,
                  prepareUnderLock:async()=>{
                    durablePrepared=await prepareMaintenanceInventorySubmission({
                      client,task,store,match,requestRow:row,payloadHash,authorizationId,journalFile:inventoryJournalFile,calls,
                      expectedCurrentInventory:hasExpectedCurrentInventory?expectedCurrentInventory:null,
                    });
                    inventoryPreflight=durablePrepared.inventoryPreflight;
                    return durablePrepared;
                  },
                  readFenceBundle:()=>readMaintenanceInventoryBundle(inventoryJournalFile),
                  submit:prepared=>{
                    const activeIntent=prepared.intent;
                    const scope=prepared.inventoryScope;
                    return client.request(activeIntent.request.pathname,{
                      method:activeIntent.request.method,
                      body:activeIntent.request.body,
                      headers:activeIntent.request.headers,
                      inventoryScope:{...scope,requestPayloadHash:activeIntent.requestPayloadHash,intentId:activeIntent.intentId,logicalActionKey:activeIntent.logicalActionKey},
                    });
                  },
                  readback:async(_attempt,prepared)=>{
                    const activeIntent=prepared.intent;
                    const scope=prepared.inventoryScope;
                    const after=await readbackStock(client,[{...match,skuCodes:[activeIntent.skuCode]}],calls,Number(activeIntent.targetUsableInventory),scope.warehouseCode);
                    const exact=exactInventoryRow(after,activeIntent.skuCode);
                    return exact?{...exact,ok:true}:{ok:false,totalUsableInventory:null,status:after?.status||'stock_query_readback_mismatch'};
                  },
                  maxReadbackAttempts:1,
                }),
              });
            }catch(error){
              if(error?.inventoryIntentDurable===true) throw error;
              const compact=preNetworkInventoryBlock(error,{operation:p.operation,submissionPlan});
              calls.push(compact);
              submitResults.push(compact);
              blockers.push(compact.msg);
              break;
            }
            if(!guardedWrite.ok){
              blockers.push(...(guardedWrite.gate?.blockers||['平台动态安全闸门阻止真实提交。']));
              break;
            }
            writeAttempted=true;
            const submission=guardedWrite.value;
            const response=submission.response;
            const activeIntent=durablePrepared?.intent;
            const scope=durablePrepared?.inventoryScope;
            if(!activeIntent||!scope){
              const compact=preNetworkInventoryBlock(new Error('INVENTORY_DURABLE_PREPARATION_MISSING'),{operation:p.operation,submissionPlan});
              calls.push(compact);
              submitResults.push(compact);
              blockers.push('update_inventory durable 准备结果缺失，禁止继续。');
              continue;
            }
            p.body=activeIntent.request.body;
            const durableSubmissionPlan=submissionPlanDescriptor(p,submissionPlan.index);
            const compact={...compactCallResult(p.operation,p.endpoint,'POST',response),operation:p.operation,state:submission.state,inventoryIntent:{intentId:activeIntent.intentId,logicalActionKey:activeIntent.logicalActionKey,idempotencyKey:activeIntent.idempotencyKey,requestPayloadHash:activeIntent.requestPayloadHash,warehouseCode:scope.warehouseCode,journalFile:rel(inventoryJournalFile)},submissionPlanId:durableSubmissionPlan.submissionPlanId,submissionPlanIndex:durableSubmissionPlan.index,submissionPlanEndpoint:durableSubmissionPlan.endpoint,submissionPlanPayloadHash:durableSubmissionPlan.payloadBodyHash};
            calls.push(compact);
            submitResults.push(compact);
            if(submission.state==='readback_matched'){
              actualWriteSubmitted=true;
            }else if(submission.state==='submitted_but_readback_pending'){
              actualWriteSubmitted=true;
              recoveryRequired=true;
              blockers.push('update_inventory 已提交但库存回读未精确匹配 target='+activeIntent.targetUsableInventory+'；durable intent 已保留，禁止重发，等待人工核销。');
            }else if(submission.state==='rejected'){
              blockers.push('update_inventory 平台拒绝：'+safeString(response?.data?.msg||response?.data?.code||'未知错误',500));
            }else{
              recoveryRequired=true;
              blockers.push('update_inventory 写请求结果不确定：'+safeString(response?.data?.msg||response?.data?.code||submission.state||'unknown',500)+'；durable intent 已保留，禁止重发。');
            }
          }
          if(blockers.length) break;
          continue;
        }
        const guardedWrite=await runSheinWebhookExternalWriteGuarded({
          writeStores:[store],
          guard:testWebhookGuard||undefined,
          write:()=>client.request(p.endpoint,{method:'POST',body:p.body,headers:{language:'en'}}),
        });
        if(!guardedWrite.ok){
          blockers.push(...(guardedWrite.gate?.blockers||['平台动态安全闸门阻止真实提交。']));
          break;
        }
        writeAttempted=true;
        const response=guardedWrite.value;
        const compact=compactCallResult(p.operation,p.endpoint,'POST',response);
        calls.push(compact);
        submitResults.push({
          ...compact,
          operation:p.operation,
          submissionPlanId:submissionPlan.submissionPlanId,
          submissionPlanIndex:submissionPlan.index,
          submissionPlanEndpoint:submissionPlan.endpoint,
          submissionPlanPayloadHash:submissionPlan.payloadBodyHash,
        });
        if(p.operation==='update_description'){
          const codeOk=String(response.data?.code)==='0';
          const successExplicit=response.data?.info?.success===true;
          const version=safeString(response.data?.info?.version||'',160);
          if(!codeOk){
            blockers.push(`${p.operation} 返回失败：${safeString(response.data?.msg||response.data?.code||'未知错误')}`);
          }else if(!successExplicit){
            // success===false is a definitive platform rejection; success
            // missing/undefined is ambiguous. Neither may produce
            // actualWriteSubmitted or reach readback.
            submitResults[submitResults.length-1].successNotExplicit=String(response.data?.info?.success);
            if(response.data?.info?.success===false){
              blockers.push(`${p.operation} 平台校验失败：${safeString(
                asArray(response.data?.info?.pre_valid_result).flatMap(row=>asArray(row?.messages)).map(v=>safeString(v,300)).join('；') || 'info.success=false 但无详细错误',
                500,
              )}`);
            }else{
              submitResults[submitResults.length-1].submittedUnconfirmed=true;
              recoveryRequired=true;
              blockers.push(`${p.operation} 成功判定必须 code=0 且 info.success=true；当前 info.success=${String(response.data?.info?.success)}；写请求已发出但成功未确认，任务保持 submitted_unconfirmed，禁止重试，必须人工核销。`);
            }
          }else if(!version){
            submitResults[submitResults.length-1].submittedUnconfirmed=true;
            blockers.push(`${p.operation} 平台返回成功但缺少 info.version，无法确认提交完成；任务保持 submitted_unconfirmed，必须人工核销，禁止重试。`);
            recoveryRequired=true;
          }
          continue;
        }
      if(correction&&p.operation==='pending_new_listing_revoke'){
        if(!correctionResponseSucceeded(response)){
          blockers.push(`待审核新品撤回失败：${safeString(response.data?.msg||response.data?.code||'未知错误')}`);
          break;
        }
        const withdrawn=await waitForPendingCorrectionState(client,correction,4,calls);
        correctionReadback={phase:'revoke',...withdrawn};
        if(!withdrawn.ok||withdrawn.documentState!==4){
          recoveryRequired=true;
          blockers.push(`平台已接收撤回请求，但尚未精确回读到 documentState=4；当前=${withdrawn.documentState??'unknown'}，保留任务稍后从状态回读继续。`);
          break;
        }
        continue;
      }
      if(correction&&p.operation==='pending_new_listing_republish'){
        correctionPublishResult={httpStatus:response.status,code:response.data?.code??null,msg:response.data?.msg??null,traceId:response.data?.traceId??null,info:response.data?.info??null};
        if(!correctionResponseSucceeded(response)){
          recoveryRequired=true;
          const errors=asArray(response.data?.info?.pre_valid_result).flatMap(row=>asArray(row?.messages)).map(value=>safeString(value,300)).filter(Boolean);
          blockers.push(`待审核新品完整重提失败，商品保持已撤回，可重新预演后恢复：${errors.join('；')||safeString(response.data?.msg||response.data?.code||'未知错误')}`);
          break;
        }
        actualWriteSubmitted=true;
        const nextVersion=safeString(response.data?.info?.version||'',160);
        if(!nextVersion){
          correctionReadback={ok:false,phase:'republish',documentState:null,reason:'publishOrEdit success response missing version'};
        }else{
          const republished=await waitForPendingCorrectionState(client,{...correction,documentVersion:nextVersion},1,calls);
          correctionReadback={phase:'republish',version:nextVersion,...republished};
        }
        continue;
      }
      if(String(response.data?.code)!=='0'){
        blockers.push(`${p.operation} 返回失败：${safeString(response.data?.msg||response.data?.code||'未知错误')}`);
      }else if(response.data?.info?.success===false){
        const errs=(response.data?.info?.pre_valid_result||[]).map(v=>`[${v.form||v.module||''}] ${(v.messages||[]).join('; ')}`).join(' | ');
        blockers.push(`${p.operation} 校验失败：${errs||'info.success=false 但无详细错误'}`);
      }
      }
      if(!correction){
        if(intents.includes('update_description')){
          // Strict: only the update_description operation itself may produce
          // actualWriteSubmitted, and only with code=0 AND info.success===true
          // AND a non-empty info.version. Missing success or version can never
          // reach readback/matched.
          actualWriteSubmitted=submitResults.some(r=>
            r.operation==='update_description'
            && String(r.code)==='0'
            && r.infoSuccess===true
            && Boolean(String(r.infoVersion||'').trim())
          );
        }else{
          actualWriteSubmitted=submitResults.some(r=>String(r.code)==='0' && r.infoSuccess!==false);
        }
      }
      if(actualWriteSubmitted&&intents.includes('update_description')&&submitResults.some(r=>r.operation==='update_description'&&r.submittedUnconfirmed===true)){
        actualWriteSubmitted=false;
        writeAttempted=true;
        recoveryRequired=true;
      }
    }
  }
  const preNetworkInventoryResult=submitResults.find(row=>row?.operation==='update_inventory'&&row?.preNetwork===true);
  const readbackCalls=[]; let readback=preNetworkInventoryResult
    ? {ok:false,status:'pre_network_blocked',calls:readbackCalls}
    : {ok:false,status:args.mode==='execute'?'not_run':'planned_not_run',calls:readbackCalls};
  const expectedInventory=intents.includes('update_inventory')?numberForTask('update_inventory',task,String(task?.command||task?.text||'')):null;
  const submittedDescriptionVersion = String(
    submitResults.find(r=>r.operation==='update_description')?.infoVersion || ''
  ).trim();
  if(actualWriteSubmitted){
    readback=correction
      ?{ok:Boolean(correctionReadback?.ok&&correctionReadback?.documentState===1),status:correctionReadback?.ok&&correctionReadback?.documentState===1?'matched_pending_document_state':'pending_document_state_readback_failed',matchedRows:correctionReadback?.ok?[correction.identity]:[],calls:readbackCalls,evidence:correctionReadback}
      :await readbackForIntents(client,intents,resolved.matches,readbackCalls,expectedInventory,task,descriptionPreflight,submittedDescriptionVersion,payloads,submitResults);
  }
  const state=args.mode==='execute'
    ? (actualWriteSubmitted
        ? 'submitted'
        : (descriptionAlreadyMatched
            ? 'update_description_already_matched'
            : (recoveryRequired
                ? (intents.includes('update_description') ? 'update_description_submitted_unconfirmed' : 'pending_listing_image_correction_recovery_required')
                : 'blocked')))
    : (blockers.length
        ? 'blocked'
        : (descriptionAlreadyMatched ? 'update_description_already_matched' : 'ready_for_submit'));
  const output={ok:blockers.length===0, runId, mode:args.mode, adapterKind:'link_maintenance_openapi_executor', state, startedAt, endedAt:new Date().toISOString(), storeKey:store, alreadyMatched:descriptionAlreadyMatched, task:{id:task.id||'',status:task.status||'',intents,productRefs:taskProductRefs(task)}, payload:{found:Boolean(payloadHash), payloadHash, payloadHashAlgorithm:payloadHash?'sha256-stable-json-v1':'', summary:{operations:payloads.map(p=>p.operation), endpoints:payloads.map(p=>p.endpoint), targetCount:resolved.matches.length, skuCount:unique(resolved.matches.flatMap(m=>m.skuCodes)).length, imagePayloadInspection:{payloadCount:imagePayloadInspection.payloadCount,totalSpuImages:imagePayloadInspection.totalSpuImages,totalSkcImages:imagePayloadInspection.totalSkcImages,totalSiteDetailImages:imagePayloadInspection.totalSiteDetailImages,totalSkuImages:imagePayloadInspection.totalSkuImages,totalDetailImages:imagePayloadInspection.totalDetailImages,totalUrlRefs:imagePayloadInspection.totalUrlRefs,uniqueUrlCount:imagePayloadInspection.uniqueUrlCount}}, submitPlan}, adapterEvidence:{realSubmit:actualWriteSubmitted,writeAttempted,recoveryRequired,correctionStateBefore,correctionReadback,correctionFingerprint:correction?.correctionFingerprint||'',sourceTaskId:correction?.sourceTaskId||'',protectedFieldsHash:correction?.protectedFieldsHash||'',phaseResults:submitResults,...(writeClaimEvidence?{writeClaim:writeClaimEvidence}:{}),canSilentWrite:false,matchedLinksCount:resolved.matches.length,matchedLinks:resolved.matches.slice(0,80),linkSnapshotFile:linkLoad.file?rel(linkLoad.file):'',productCacheFile:productLoad.file?rel(productLoad.file):'',siteInfo,imagePayloadInspection,inventoryPreflight,calls}, publishResult: correction ? correctionPublishResult : (actualWriteSubmitted ? {code:'0', msg:'submitted', traceId:submitResults.map(x=>x.traceId).filter(Boolean).join(',')||null, operations:submitResults} : null), readbackFingerprint:{taskId:task.id||'', intents, targetStores:[store], matchedSkcs:resolved.matches.map(m=>m.skc).filter(Boolean), matchedSkuCodes:unique(resolved.matches.flatMap(m=>m.skuCodes)), payloadHash, readbackStatus:readback.status}, readback, blockers, warnings, safety:{canSilentWrite:false,executeRequiresConfirm:SUBMIT_CONFIRM_TEXT,dryRunDoesNotCallBusinessWrite:args.mode!=='execute',inventoryPreflightRequired:intents.includes('update_inventory'),pendingListingCorrection:correction?{sourceTaskRequired:true,exactIdentityRequired:true,approvedBindingRequired:true,phasedRevokeAndRepublish:true,protectedFieldsUntouched:true}:null,note:'维护写真实提交必须由账号权限、动作总闸门、payload hash 和确认文本共同放行；待审核新品纠图还必须撤回成功并精确回读 state=4 后，才可用原完整 payload 重提。'}};
  output.partial=false;
  output.committed=Boolean(actualWriteSubmitted);
  output.outcome=args.mode!=='execute'
    ? (blockers.length ? 'blocked' : 'ready')
    : (blockers.length
        ? 'blocked'
        : (recoveryRequired || actualWriteSubmitted
            ? (readback.ok ? 'completed' : 'unconfirmed')
            : 'blocked'));
  if(actualWriteSubmitted && !readback.ok){
    output.ok=false;
    output.partial=true;
    output.outcome='unconfirmed';
    output.committed=true;
    output.state='submitted';
    // A partial commit must never clear blockers: an earlier operation may have
    // been durably committed while a later operation was definitively rejected
    // by the platform. Preserve every existing blocker verbatim and supplement
    // an explicit readback-unconfirmed blocker/warning so the reason the batch
    // is not a completed success stays visible; never auto-retry.
    const unconfirmedReason='写接口已提交但强回读未确认：持久提交与 durable claim 已保留，任务必须锁定等待人工核销，禁止重复提交或升级为业务完成。';
    if(!blockers.some(b=>/回读|readback|未确认/.test(String(b)))) blockers.push(unconfirmedReason);
    if(!output.warnings.some(w=>/回读|readback|未确认/.test(String(w)))) output.warnings.push(unconfirmedReason);
  } else if(actualWriteSubmitted && readback.ok){
    if(blockers.length===0){
      output.outcome='completed';
      output.committed=true;
    }else{
      // A surviving platform blocker inside the same batch forbids 'completed';
      // keep the durable claim recorded as submitted+unconfirmed instead.
      output.ok=false;
      output.partial=true;
      output.outcome='unconfirmed';
      output.committed=true;
      output.state='submitted';
    }
  }
  if(descriptionPreflight){ output.adapterEvidence.descriptionPreflight=descriptionPreflight; }
  if(descriptionSummary){ output.payload.summary.descriptionUpdate=descriptionSummary; }
  if(actualWriteSubmitted&&intents.includes('update_description')){
    const descriptionLifecycle=classifyUpdateDescriptionLifecycle({executeOk:true,readback});
    output.descriptionLifecycle=descriptionLifecycle;
    // Top-level state stays 'submitted' so the portal lifecycle classifier can
    // decide matched/pending from the readback outcome; the detailed
    // descriptionLifecycle is carried alongside for audit and manual resolve.
    if(descriptionLifecycle.needsManualResolve){
      output.warnings.push('描述回读未精确匹配：任务保持 submitted_readback_pending，必须人工核销，禁止重复提交。');
    }
  }
  if(descriptionAlreadyMatched){
    output.descriptionLifecycle={lifecycleStatus:'description_already_matched',status:'description_already_matched',needsManualResolve:false,alreadyMatched:true};
  }
  if(intents.includes('update_description')&&args.mode==='execute'&&writeAttempted&&!actualWriteSubmitted&&recoveryRequired){
    output.ok=false;
    output.partial=true;
    output.outcome='unconfirmed';
    output.state='update_description_submitted_unconfirmed';
    output.descriptionLifecycle={lifecycleStatus:'submitted_readback_pending',status:'submitted_readback_pending',needsManualResolve:true};
    output.adapterEvidence.submittedPossibly=true;
    output.submittedPossibly=true;
    output.warnings.push('partialEdit 已发出但成功未确认（info.version 缺失）：任务保持 submitted_unconfirmed，禁止重复提交，必须人工核销。');
  }
  const outPath=path.join(args.outDir,`${runId}.local.json`); await writeJson(outPath,output); output.savedTo=rel(outPath); if(!args.quiet) console.log(JSON.stringify(output,null,2));
  if(args.mode==='execute'&&blockers.length>0&&!actualWriteSubmitted&&!recoveryRequired){
    process.exitCode=1;
  }
}

export const __testHooks=Object.freeze({loadExactSpuInfoReadback,operationSubmissionEvidence,readbackForIntents,submissionPlanDescriptor});

const IS_DIRECT_RUN=Boolean(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url)));
if(IS_DIRECT_RUN) main().catch(err=>{
  const durable=err?.inventoryIntentDurable===true;
  const output={ok:false,adapterKind:'link_maintenance_openapi_executor',state:durable?'suspicious_write_attempted':'blocked',outcome:durable?'unconfirmed':'blocked',committed:false,partial:durable,adapterEvidence:{realSubmit:false,writeAttempted:durable,sheinWriteAttempted:durable,recoveryRequired:durable,preNetwork:!durable},publishResult:null,readback:{ok:false,status:durable?'durable_intent_after_transport_unknown':'pre_network_blocked',calls:[]},blockers:[safeString(err?.message||err,800)],warnings:durable?['durable intent 已写入后发生中断；保持人工核销/禁止重发。']:[]};
  console.log(JSON.stringify(output,null,2));
  console.error(err?.stack||err?.message||String(err));
  process.exit(1);
});
