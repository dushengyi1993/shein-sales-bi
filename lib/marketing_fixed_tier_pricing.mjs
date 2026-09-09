import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inferNewListingShelfAgeDays,isRecentNewListingLink} from './marketing_pricing_policy.mjs';
import {readReviewedWorkbookPrice} from './marketing_ordinary_campaign_approval.mjs';
import {PRICE_VARIATION_POLICY,priceVariationSeed,resolveTierPriceVariation} from './marketing_price_variation.mjs';

export const FIXED_TIER_STANDARD_URL = new URL('../config/marketing_fixed_tier_standard.json', import.meta.url);
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const num = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const key = row => `${String(row?.storeKey ?? row?.store_key ?? row?.store ?? '').toUpperCase()}::${row?.skc ?? row?.SKC ?? ''}`;
export const fixedTierCanonicalKey = value => {
  const text=String(value || '').normalize('NFKC').trim();
  return text.match(/^[A-Za-z0-9-]+/)?.[0].replaceAll('-', '').toUpperCase() || text.replace(/\s+/g,'');
};
const canonicalOf = row => row?.canonical || row?.standard_goods_sn || row?.standardGoodsSn || row?.goodsSn || row?.supplierNo || '';

export function loadFixedTierStandard() {
  const bytes = fs.readFileSync(FIXED_TIER_STANDARD_URL);
  const doc = JSON.parse(bytes);
  if (doc.schemaVersion !== 'marketing-fixed-tier-standard/v1' || !doc.version || doc.currency !== 'SAR' || !Array.isArray(doc.items)) throw Error('fixed_tier_standard_invalid');
  if (doc.priceVariation && (doc.priceVariation.version!==PRICE_VARIATION_POLICY.version
    || doc.priceVariation.effectiveDate!==PRICE_VARIATION_POLICY.effectiveDate
    || JSON.stringify(doc.priceVariation.priceRangeSar)!=='[-2,1]'
    || JSON.stringify(doc.priceVariation.marginRangePercentagePoints)!=='[-2,1]')) throw Error('price_variation_policy_changed');
  const keys = new Set();
  for (const item of doc.items) {
    const k = fixedTierCanonicalKey(item.canonical);
    if (!k || keys.has(k) || item.prices?.length !== 3 || item.prices.some(p => !Number.isFinite(p) || p <= 0)) throw Error('fixed_tier_standard_invalid_item');
    keys.add(k);
  }
  return {doc, sha256:hash(bytes)};
}

export function fixedTierItem(canonical, standard = loadFixedTierStandard()) {
  return standard.doc.items.find(item => fixedTierCanonicalKey(item.canonical) === fixedTierCanonicalKey(canonical)) || null;
}

function rowsOf(doc) {
  const data = doc?.data || doc || {};
  return [...(data.storeLinks || []), ...(data.links || [])];
}
function shelf(row) {
  const value = row?.is_on_shelf ?? row?.isOnShelf;
  const status = String(row?.shelf_status_name || row?.shelfStatusName || row?.visible_shelf_statuses || '');
  if ([false,0,'0'].includes(value) || row?.is_out_shelf === true || /下架|售罄|SOLD_OUT|OUT_SHELF/i.test(status)) return false;
  return [true,1,'1'].includes(value) || /已上架|在售|ON_SHELF/i.test(status) ? true : null;
}
export function buildFixedTierContext(linksDataDoc, {reportDate = '', standard = loadFixedTierStandard(),costDoc={},baselineDoc={},reviewedWorkbookPriceCapability=null} = {}) {
  const byKey = new Map();
  for (const row of rowsOf(linksDataDoc)) {
    const k = key(row);
    if (k === '::') continue;
    const prior = byKey.get(k);
    // Conflicting duplicate evidence must not pick an arbitrary tier.
    if (prior && hash(prior) !== hash(row)) byKey.set(k, {...row, fixedTierDuplicateConflict:true});
    else byKey.set(k, row);
  }
  const baselineKeys=new Set((baselineDoc.items || []).filter(r=>num(r.finalTargetPrice ?? r.targetPrice)>0 && (r.fixedTierPricing || r.lowEtFastSellerPricePullback?.fixedTierPricing)?.mode!=='missing_standard_full_cost_margin').map(r=>fixedTierCanonicalKey(canonicalOf(r))));
  return {standard, reportDate, byKey,costDoc,baselineKeys,reviewedWorkbookPriceCapability};
}

export function fullTierCost(canonical,costDoc={}) {
  const wanted=fixedTierCanonicalKey(canonical);
  const keys=[...new Set([...Object.keys(costDoc.trueCostMap || {}),...Object.keys(costDoc.costMap || {})])].filter(k=>fixedTierCanonicalKey(k)===wanted).sort();
  const records=keys.map(k=>{
    const full=costDoc.trueCostMap?.[k] || {},raw=costDoc.costMap?.[k];
    const product=num(full.productUnitCostSar ?? full.unitCostSar ?? (typeof raw==='object' ? raw?.productUnitCostSar ?? raw?.unitCostSar : raw));
    const storage=num(full.storageUnitCostSar ?? full.storageUnitCostSar30d);
    const complete=product!==null && product>0 && storage!==null && storage>=0;
    return {complete,costKey:k,productUnitCostSar:product,storageUnitCostSar:storage,fullUnitCostSar:complete?product+storage:null,reason:complete?'complete':product===null?'missing_product_cost':'missing_storage_cost'};
  });
  // Aliases may omit storage, but every known component must agree. Never
  // synthesize a complete cost by combining two incomplete source records.
  if (!records.length || ['productUnitCostSar','storageUnitCostSar'].some(field=>new Set(records.map(r=>r[field]).filter(v=>v!==null)).size>1)) return {complete:false,reason:'missing_or_ambiguous_product_cost'};
  const complete=records.filter(r=>r.complete);
  const candidates=complete.length?complete:records;
  return candidates.find(r=>r.costKey===canonical) || candidates[0];
}

export function applyPlatformPriceConstraint({targetPrice,platformMaximum=null,fullUnitCostSar=null}) {
  const target=num(targetPrice),maximum=num(platformMaximum),cost=num(fullUnitCostSar);
  if (!(target>0) || (maximum!==null && maximum<=0)) return {ok:false,reason:'invalid_platform_or_target_price'};
  const actual=maximum===null?target:Math.min(target,maximum);
  return {ok:true,originalTargetPrice:target,actualPrice:actual,platformMaximum:maximum,differenceSar:Math.round((actual-target)*100)/100,actualMargin:cost!==null?(actual-cost)/actual:null,fullUnitCostSar:cost,platformAdjusted:actual!==target};
}

export function classifyFixedTierLink(row, context) {
  const item = {canonical:canonicalOf(row)};
  const blocked = (reason,evidence={}) => ({ok:false,reason,evidence});
  const link = context?.byKey?.get(key(row));
  if (!link || link.fixedTierDuplicateConflict) return blocked('fixed_tier_missing_or_conflicting_link_evidence');
  if (fixedTierCanonicalKey(canonicalOf(link)) !== fixedTierCanonicalKey(item.canonical)) return blocked('fixed_tier_link_identity_changed');
  if (shelf(link) !== true) return blocked('fixed_tier_on_shelf_evidence_missing');
  const exposure = num(link.c7_eps_uv ?? link.c7EpsUv);
  const clicks = num(link.c7_goods_uv ?? link.c7GoodsUv);
  const cart = num(link.c7_cart_uv ?? link.c7CartUv);
  const sales = num(link.c7_sale_cnt ?? link.c7SaleCnt);
  const rate = exposure !== null && exposure > 0 && clicks !== null ? clicks/exposure : num(link.c7_click_rate ?? link.c7ClickRate);
  const metrics = {exposure,clicks,cart,sales,rate};
  if (exposure === null || sales === null || exposure < 0 || sales < 0) return blocked('fixed_tier_missing_classification_metrics',metrics);
  const high = sales === 0 && ((exposure > 3000 && rate !== null && rate > .04) || (exposure >= 3000 && cart !== null && cart >= 20));
  if (!high && sales === 0 && ((exposure > 3000 && rate === null) || (exposure >= 3000 && cart === null))) return blocked('fixed_tier_high_click_qualification_unknown',metrics);
  let tier = high ? 0 : null;
  let rank = null;
  let rankBounds = null;
  let ranking = [];
  const age = inferNewListingShelfAgeDays(link,context.reportDate).value;
  const recent = isRecentNewListingLink(link,undefined,context.reportDate);
  if (tier === null) {
    if (recent.applies) tier = 1;
    else {
      const peers = [...context.byKey.values()].filter(r => fixedTierCanonicalKey(canonicalOf(r)) === fixedTierCanonicalKey(item.canonical) && shelf(r) !== false);
      if (peers.some(r => shelf(r) !== true || r.fixedTierDuplicateConflict || (num(r.c7_eps_uv ?? r.c7EpsUv) ?? 0) < 0)) return blocked('fixed_tier_global_exposure_evidence_incomplete');
      const missingKeys = peers.filter(r => num(r.c7_eps_uv ?? r.c7EpsUv) === null).map(key).sort();
      ranking = peers.map(r => ({key:key(r),exposure:num(r.c7_eps_uv ?? r.c7EpsUv)})).filter(r => r.exposure !== null).sort((a,b) => b.exposure-a.exposure || a.key.localeCompare(b.key));
      const bestRank = ranking.findIndex(r => r.key === key(row)) + 1;
      if (!bestRank) return blocked('fixed_tier_global_rank_missing');
      const worstRank = bestRank + missingKeys.length;
      // Missing exposure can move a known link down at most once per missing
      // peer. Classify only when both bounds stay on the same side of top five.
      if (missingKeys.length) rankBounds = {minimum:bestRank,maximum:worstRank,missingKeys};
      else rank = bestRank;
      if (bestRank <= 5 && worstRank > 5) return blocked('fixed_tier_global_exposure_evidence_incomplete',{rankBounds});
      tier = worstRank <= 5 ? 1 : 2;
      if (tier === 2 && age === null) return blocked('fixed_tier_new_listing_evidence_missing');
    }
  }
  return {ok:true,tier,metrics,age,recent,rank,ranking,rankBounds};
}

export function resolveFixedTierPrice(row, context) {
  const standard = context?.standard || loadFixedTierStandard();
  const reviewed = readReviewedWorkbookPrice(context?.reviewedWorkbookPriceCapability, row, context?.reportDate);
  if (reviewed.applies && !reviewed.ok) return {applies:true,blocked:true,reason:reviewed.reason};
  if (context?.reportDate && context.reportDate < standard.doc.effectiveDate) return {applies:false};
  const fixed = fixedTierItem(canonicalOf(row), standard);
  const inherited=(standard.doc.inheritedStandards || []).find(r=>fixedTierCanonicalKey(r.canonical)===fixedTierCanonicalKey(canonicalOf(row)));
  const defaultRule=standard.doc.missingStandardMargins;
  if (!reviewed.applies && !fixed && !inherited && (!defaultRule || (context?.baselineKeys?.has(fixedTierCanonicalKey(canonicalOf(row))) && (row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing)?.mode!=='missing_standard_full_cost_margin'))) return {applies:false};
  if (!canonicalOf(row)) return {applies:false};
  const item=fixed || {canonical:canonicalOf(row)};
  const blocked = (reason, evidence = {}) => ({applies:true, blocked:true, reason, canonical:item.canonical, ruleVersion:standard.doc.version, ruleHash:standard.sha256, evidence});
  if (!reviewed.applies && inherited && !fixed && inherited.type!=='inherited_full_cost_margins') return blocked('existing_user_standard_requires_latest_reconciliation');
  if (!reviewed.applies && !fixed && !inherited) {
    const proof=(defaultRule.confirmedMissingCanonicals || []).find(p=>fixedTierCanonicalKey(p.canonical)===fixedTierCanonicalKey(item.canonical));
    if (!proof || !/^[a-f0-9]{64}$/.test(proof.evidenceSha256 || '') || !proof.sourceVersion) return blocked('existing_user_standard_coverage_unverified');
  }
  const classification = classifyFixedTierLink(row,context);
  if (!classification.ok) return blocked(classification.reason,classification.evidence);
  const {tier,metrics,age,recent,rank,ranking,rankBounds} = classification;
  if (reviewed.applies && reviewed.tier !== tier) return blocked('reviewed_workbook_price_tier_changed',{approvedTier:reviewed.tier,currentTier:tier});
  // Subsequent explicit exceptions live in versioned authority or a verified current workbook approval.
  const exceptions = (standard.doc.exceptions || []).filter(e => fixedTierCanonicalKey(e.canonical) === fixedTierCanonicalKey(item.canonical) && (!e.storeKey || e.storeKey === key(row).split('::')[0]) && (!e.skc || e.skc === String(row.skc)));
  const exception = exceptions.at(-1);
  if (exception && (!exception.authorization || !exception.authorizedAt || exception.authorizedAt < standard.doc.effectiveDate || !(num(exception.price) > 0))) return blocked('fixed_tier_invalid_user_exception');
  const cost=fullTierCost(item.canonical,context?.costDoc);
  if (reviewed.applies && (!cost.complete || cost.productUnitCostSar !== reviewed.productUnitCostSar
    || cost.storageUnitCostSar !== reviewed.storageUnitCostSar)) return blocked('reviewed_workbook_price_cost_changed',cost);
  if (!fixed && !exception && !cost.complete) return blocked('pricing_'+cost.reason,cost);
  let margin=reviewed.applies || fixed?null:inherited ? (tier===2?inherited.regularMargin:inherited.top5Margin) : defaultRule.tiers[tier];
  if (!reviewed.applies && margin!==null && (!(margin>=0) || !(margin<1))) return blocked('invalid_inherited_margin');
  let target = reviewed.applies ? reviewed.price : exception ? exception.price : fixed ? item.prices[tier] : Math.ceil((cost.fullUnitCostSar/(1-margin)-Number.EPSILON)*100)/100;
  if(inherited && !fixed && !exception && !reviewed.applies && tier===0) {
    const topPrice=cost.fullUnitCostSar/(1-inherited.top5Margin);
    const specialMargin=(topPrice-cost.productUnitCostSar)/topPrice-.02;
    if(specialMargin<.15 || specialMargin>=1) return blocked('inherited_high_click_margin_below_floor',{topPrice,specialMargin});
    target=Math.ceil((cost.productUnitCostSar/(1-specialMargin)-Number.EPSILON)*100)/100;
    if(target>=topPrice) return blocked('inherited_high_click_price_not_below_top5');
    margin=specialMargin;
  }
  const max = num(row.platformMaxAllowedSignupPrice ?? row.platformMaximumActivityPrice ?? row.maxAllowedActivityPrice ?? reviewed.variation?.platformMaximum);
  let priceVariation=reviewed.applies?reviewed.variation:null;
  const variationPolicy=standard.doc.priceVariation;
  if (!reviewed.applies && !exception && variationPolicy && context.reportDate>=variationPolicy.effectiveDate) {
    if (variationPolicy.version!==PRICE_VARIATION_POLICY.version) return blocked('price_variation_policy_changed');
    if (!cost.complete) return blocked('pricing_'+cost.reason,cost);
    let basis;
    if (fixed) basis={kind:'price',tiers:item.prices};
    else if (inherited) {
      const topPrice=cost.fullUnitCostSar/(1-inherited.top5Margin);
      const highProductMargin=(topPrice-cost.productUnitCostSar)/topPrice-.02;
      const highPrice=cost.productUnitCostSar/(1-highProductMargin);
      basis={kind:'full_cost_margin',tiers:[1-cost.fullUnitCostSar/highPrice,inherited.top5Margin,inherited.regularMargin],
        minimumMargins:[1-cost.fullUnitCostSar/(cost.productUnitCostSar/.85),.15,.15]};
    } else basis={kind:'full_cost_margin',tiers:defaultRule.tiers};
    try {
      priceVariation=resolveTierPriceVariation({basis,tier,fullUnitCostSar:cost.fullUnitCostSar,
        seedKey:priceVariationSeed({...row,canonical:item.canonical},context.reportDate),platformMaximum:max});
      target=priceVariation.prePlatformPrice;
    } catch(error) { return blocked(error.message); }
  }
  const platform=applyPlatformPriceConstraint({targetPrice:target,platformMaximum:priceVariation && max!==null?Math.floor(max*100+1e-8)/100:max,fullUnitCostSar:cost.fullUnitCostSar});
  if (!platform.ok) return blocked(platform.reason);
  const price=platform.actualPrice;
  const evidence = {key:key(row),canonical:item.canonical,reportDate:context.reportDate,metrics,age,newListing:recent,rank,ranking,...(rankBounds?{rankBounds}:{}),cost,exception:exception || null,...(reviewed.applies?{reviewedWorkbookPrice:reviewed.binding}:{}),...(priceVariation?{priceVariation}:{})};
  if (reviewed.applies) margin=(target-cost.fullUnitCostSar)/target;
  const binding = {schemaVersion:'marketing-fixed-tier-binding/v1',ruleVersion:standard.doc.version,ruleHash:standard.sha256,canonical:item.canonical,tier,price,originalTargetPrice:target,mode:reviewed.applies?'reviewed_workbook_price':fixed?'fixed_sar':inherited?'inherited_user_standard':'missing_standard_full_cost_margin',marginTarget:margin,inheritedSource:inherited || null,platform,...(priceVariation?{baselinePrice:priceVariation.baselinePrice,priceVariation}:{}),evidenceHash:hash(evidence),evidence};
  return {applies:true,blocked:false,price,binding};
}

export function applyFixedTierPrice(row, context) {
  const decision = resolveFixedTierPrice(row,context);
  if (!decision.applies) return null;
  if (decision.blocked) return {row:{...row,fixedTierPricing:decision.binding || decision},applied:false,blocked:true,reason:decision.reason,evidence:decision.evidence};
  if (decision.binding.mode === 'reviewed_workbook_price') {
    for (const field of ['targetPrice','finalTargetPrice','limitedDiscountPrice','specialPrice']) {
      if (row[field] !== undefined && ![decision.price,decision.binding.originalTargetPrice].includes(num(row[field]))) {
        return {row:{...row},applied:false,blocked:true,reason:'reviewed_workbook_exact_price_changed'};
      }
    }
  }
  const audit = {applied:true,mode:'user_fixed_tier',priority:0,fixedTierPricing:decision.binding};
  return {row:{...row,targetPrice:decision.price,finalTargetPrice:decision.price,limitedDiscountPrice:decision.price,intendedFinalTargetPrice:decision.binding.originalTargetPrice,platformPriceAudit:decision.binding.platform,fixedTierPricing:decision.binding,lowEtFastSellerPricePullback:audit},applied:true,blocked:false,reason:'user_fixed_tier',audit};
}

export function verifyFixedTierBinding(row, context, {platformMaximum = null} = {}) {
  const stored=row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing;
  const current = resolveFixedTierPrice({...row,platformMaximumActivityPrice:platformMaximum ?? row.platformMaximumActivityPrice ?? stored?.platform?.platformMaximum},context);
  if (!current.applies) return {ok:true,applies:false};
  if (current.blocked) return {ok:false,reason:current.reason,current};
  const planned = row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing;
  // The loaded workbook approval is itself an exact current price binding; old
  // fixed-tier annotations must not override the newly locked workbook row.
  if ((current.binding.mode !== 'reviewed_workbook_price' || planned?.mode === 'reviewed_workbook_price')
    && (!planned || planned.ruleHash !== current.binding.ruleHash || planned.evidenceHash !== current.binding.evidenceHash || planned.price !== current.price || planned.tier !== current.binding.tier)) return {ok:false,reason:'fixed_tier_rule_or_evidence_changed_rebuild_required',current};
  for (const field of ['targetPrice','finalTargetPrice','limitedDiscountPrice','specialPrice']) {
    const approvedBeforeApply = current.binding.mode === 'reviewed_workbook_price'
      && planned?.mode !== 'reviewed_workbook_price' && num(row[field]) === current.binding.originalTargetPrice;
    if (row[field] !== undefined && num(row[field]) !== current.price && !approvedBeforeApply) return {ok:false,reason:'fixed_tier_exact_price_changed',field,current};
  }
  return {ok:true,applies:true,binding:current.binding};
}

export function verifyPlatformPriceAudit(row,audit) {
  if (!audit || audit.ruleHash!==loadFixedTierStandard().sha256 || audit.skc!==String(row.skc)) return null;
  const binding=row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing;
  const original=num(binding?.originalTargetPrice ?? row.limitedDiscountPrice ?? row.specialPrice ?? row.targetPrice);
  if (audit.originalTargetPrice!==original || !(num(audit.platformMaximum)>0)) return null;
  const actual=Math.round(Math.min(original,audit.platformMaximum)*100)/100;
  if (audit.actualPrice!==actual || audit.differenceSar!==Math.round((actual-original)*100)/100) return null;
  return audit;
}

export async function verifyFixedTierRescue({root, rescue, reportDate}) {
  const targets=(rescue.rows || []).filter(row=>fixedTierItem(canonicalOf(row)) || row.fixedTierPricing || row.lowEtFastSellerPricePullback?.fixedTierPricing);
  if (!targets.length) return {ok:true,rows:[]};
  const file=path.resolve(root,rescue.sourceLinksData || 'outputs/bi-portal/sections/linksData.json');
  const doc=JSON.parse(await fs.promises.readFile(file,'utf8'));
  const generated=doc.generatedAt || doc.data?.generatedAt;
  if (!generated || !Number.isFinite(Date.parse(generated)) || new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(generated)) !== reportDate || Date.parse(generated)>Date.now()+60_000) return {ok:false,reason:'fixed_tier_links_evidence_stale',rows:[]};
  let links=doc;
  if (rescue.sourceRawLinkHistory) {
    const {buildLinkRowIndexFromBi}=await import('./marketing_pricing_policy.mjs');
    const {collectLatestRawMarketingLinkRows,assessLatestRawMarketingLinkCoverage,mergeMarketingLinkRows}=await import('./marketing_latest_raw_link_overlay.mjs');
    const cfg=JSON.parse(await fs.promises.readFile(path.resolve(root,rescue.sourceStoresConfig || 'config/stores.json'),'utf8'));
    const storeKeys=cfg.stores.filter(s=>s.enabled!==false).map(s=>String(s.storeKey || s.key || s.store).toUpperCase());
    const raw=collectLatestRawMarketingLinkRows({historyDir:path.resolve(root,rescue.sourceRawLinkHistory),reportDate,storeKeys});
    const coverage=assessLatestRawMarketingLinkCoverage({sourceFiles:raw.sourceFiles,errors:raw.errors,storeKeys});
    if (!coverage.complete) return {ok:false,reason:'fixed_tier_global_store_evidence_incomplete',rows:[]};
    links={storeLinks:mergeMarketingLinkRows([...buildLinkRowIndexFromBi(doc).byLinkKey.values()],raw.rows).rows};
  }
  const costDoc=JSON.parse(await fs.promises.readFile(path.resolve(root,rescue.sourceCostMap || 'tmp/mbrs/marketing-cost-map.json'),'utf8'));
  const baselineDoc=rescue.sourcePriceOverrides?JSON.parse(await fs.promises.readFile(path.resolve(root,rescue.sourcePriceOverrides),'utf8')):{items:[]};
  const context=buildFixedTierContext(links,{reportDate,costDoc,baselineDoc});
  const rows=targets.map(row=>({skc:row.skc,...verifyFixedTierBinding(row,context)}));
  return {ok:rows.every(row=>row.ok),ruleHash:context.standard.sha256,rows};
}
