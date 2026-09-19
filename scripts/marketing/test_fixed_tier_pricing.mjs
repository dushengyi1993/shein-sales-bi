import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {loadFixedTierStandard, fixedTierItem, fullTierCost, buildFixedTierContext, resolveFixedTierPrice, applyFixedTierPrice, verifyFixedTierBinding,applyPlatformPriceConstraint,verifyPlatformPriceAudit} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {buildLowEtFastSellerPricingContext, applyLowEtFastSellerPricePullback, revalidateLowEtFastSellerPricePullback} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {buildHighClickLowConversionSpecialAudit} from '../../lib/marketing_high_click_special_policy.mjs';
import {PRICE_VARIATION_POLICY} from '../../lib/marketing_price_variation.mjs';

const standard=loadFixedTierStandard();
assert.equal(standard.doc.items.length,44);
// The approved standard's own price list, in its recorded order. Pinned here so
// an accidental edit to an approved tier is caught rather than silently used.
const expected=[[83.54,87.51,91.89],[241.62,247.74,254.17],[140.99,144.96,153.62],[58,62,66],[81,86,91],[76.31,77.29,82.58],[132.39,136.02,146.02],[285,293,306],[72.94,74.81,79.94],[233.64,239.33,254.88],[113.66,116.33,123.6],[93.53,95.87,102.26],[74.97,76.78,81.7],[79.55,81.42,86.5],[99.79,102.96,109.94],[115.79,118.92,127.54],[71.47,73.3,78.32],[60.73,62.2,67.04],[61.15,62.78,67.26],[219.55,225.4,241.5],[89.48,91.58,97.3],[240.35,246.59,263.71],[161.25,165.86,178.62],[157.9,163.85,180.92],[186.35,191.13,204.22],[84.94,87.04,92.77],[63.18,64.8,69.24],[89.57,91.9,98.28],[47.54,48.7,51.86],[53.07,54.32,57.72],[51.17,52.42,55.82],[272.83,279.91,299.35],[282.75,290.95,313.68],[125.18,128.48,137.53],[282.95,290.21,310.09],[107.48,110.07,117.12],[41.41,42.42,45.17],[90.81,93.03,99.07],[125.39,128.74,137.93],[86.99,89.31,95.69],[117.24,120.54,129.67],[218.63,224.46,240.49],[76.91,78.96,84.6],[305.68,313.52,334.99]];
// Must be at or after the loaded standard's effectiveDate; an earlier date makes
// resolveFixedTierPrice report applies=false and the fixture silently skips the
// standard under test.
const reportDate='2026-09-16';
const aliasCanonical='SK-GT-3065蒸汽熨烫机';
const aliasCosts={trueCostMap:{
 'SK-GT-3065':{unitCostSar:54.4737},
 'SKGT3065':{unitCostSar:54.4737},
 [aliasCanonical]:{unitCostSar:54.4737,storageUnitCostSar:.6201},
 'SKGT3065蒸汽熨烫机':{unitCostSar:54.4737,storageUnitCostSar30d:.6201},
 'SK-GT-3065W':{unitCostSar:55,storageUnitCostSar:2}
},costMap:{'SK-GT-3065':54.4737}};
const aliasCost=fullTierCost(aliasCanonical,aliasCosts);
assert.equal(aliasCost.complete,true);
assert.equal(aliasCost.costKey,aliasCanonical);
assert.ok(Math.abs(aliasCost.fullUnitCostSar-55.0938)<1e-10);
assert.deepEqual(fullTierCost(aliasCanonical,{...aliasCosts,trueCostMap:Object.fromEntries(Object.entries(aliasCosts.trueCostMap).reverse())}),aliasCost);
assert.deepEqual(fullTierCost('SKGT3065',aliasCosts),fullTierCost('SKGT3065',{...aliasCosts,trueCostMap:Object.fromEntries(Object.entries(aliasCosts.trueCostMap).reverse())}));
for(const [alias,field,value] of [['SKGT3065蒸汽熨烫机','unitCostSar',56],['SKGT3065蒸汽熨烫机','storageUnitCostSar30d',1],['SKGT3065','unitCostSar',56]]) {
 const conflicting=structuredClone(aliasCosts);conflicting.trueCostMap[alias][field]=value;
 assert.equal(fullTierCost(aliasCanonical,conflicting).reason,'missing_or_ambiguous_product_cost');
}
for(const trueCostMap of [
 {'SKGT3065':{unitCostSar:54},'SK-GT-3065':{unitCostSar:54}},
 {'SKGT3065':{unitCostSar:54},'SK-GT-3065':{storageUnitCostSar:1}},
 {'SKGT3065':{unitCostSar:0,storageUnitCostSar:1}},
 {'SKGT3065':{unitCostSar:54,storageUnitCostSar:-1}}
]) {
 const incomplete=fullTierCost(aliasCanonical,{trueCostMap});
 assert.equal(incomplete.complete,false);assert.equal(incomplete.fullUnitCostSar,null);
}
assert.equal(fullTierCost(aliasCanonical,{}).complete,false);
const aliasRows=peers(aliasCanonical);
const aliasContext=buildFixedTierContext({storeLinks:aliasRows},{reportDate,costDoc:aliasCosts});
const aliasApplied=applyFixedTierPrice({...aliasRows[6],platformMaximumActivityPrice:91.88},aliasContext);
assert.equal(aliasApplied.applied,true);
// The approved baseline for this tier is 91.89 and price variation may sample
// within [-2,+1] of it, so a 91.88 platform maximum is not necessarily binding.
// A genuinely binding cap proves the platform constraint path instead.
assert.equal(aliasApplied.row.fixedTierPricing.platform.platformAdjusted,false);
assert.ok(aliasApplied.row.fixedTierPricing.platform.actualPrice<=91.88);
const aliasCapped=applyFixedTierPrice({...aliasRows[6],platformMaximumActivityPrice:89},aliasContext);
assert.equal(aliasCapped.applied,true);
assert.equal(aliasCapped.row.fixedTierPricing.platform.actualPrice,89);
assert.equal(aliasCapped.row.fixedTierPricing.platform.platformAdjusted,true);
assert.ok(Math.abs(aliasCapped.row.fixedTierPricing.platform.actualMargin-(89-55.0938)/89)<1e-10);
assert.equal(verifyFixedTierBinding(aliasCapped.row,aliasContext).ok,true);
assert.equal(verifyFixedTierBinding(aliasApplied.row,aliasContext).ok,true);
// Unknown peer exposure stays unknown; only a proven tier may proceed.
const boundedPeers=peers(aliasCanonical);
boundedPeers[1].c7_eps_uv=null;
const boundedContext=buildFixedTierContext({storeLinks:boundedPeers},{reportDate,costDoc:aliasCosts});
const ordinaryBound=resolveFixedTierPrice(boundedPeers[6],boundedContext);
// Tier 2 baseline 91.89 with variation in [-2,+1]; exact sampled price is not
// the point of this case, the bounded-rank evidence is.
assert.equal(ordinaryBound.binding.tier,2);
assert.ok(ordinaryBound.price>=91.89-2 && ordinaryBound.price<=91.89+1);
assert.equal(ordinaryBound.binding.evidence.rank,null);
assert.deepEqual(ordinaryBound.binding.evidence.rankBounds,{minimum:6,maximum:7,missingKeys:['S1::k1']});
assert.equal(ordinaryBound.binding.evidence.ranking.length,6);
assert.equal(boundedPeers[1].c7_eps_uv,null);
const topBound=resolveFixedTierPrice(boundedPeers[0],boundedContext);
assert.equal(topBound.binding.tier,1);
// Tier 1 baseline for this canonical is 87.51.
assert.ok(topBound.price>=87.51-2 && topBound.price<=87.51+1);
assert.deepEqual(topBound.binding.evidence.rankBounds,{minimum:1,maximum:2,missingKeys:['S1::k1']});
const boundary=resolveFixedTierPrice(boundedPeers[5],boundedContext);
// With one unknown peer exposure the fifth link is only ever tier 2, so the
// classification resolves deterministically and records the bound rather than
// blocking; the evidence still records that the rank was uncertain.
assert.equal(boundary.binding.tier,2);
assert.deepEqual(boundary.binding.evidence.rankBounds,{minimum:5,maximum:6,missingKeys:['S1::k1']});
// The peer whose own exposure is unknown is classified by the reviewed tier
// fallback instead of failing the whole batch.
assert.equal(resolveFixedTierPrice(boundedPeers[1],boundedContext).binding.evidence.pricingClassificationFallback.source,'ordinary_tier_without_classification');
const boundedApplied=applyFixedTierPrice(boundedPeers[6],boundedContext);
assert.equal(verifyFixedTierBinding(boundedApplied.row,boundedContext).ok,true);
const newlyKnown=structuredClone(boundedPeers);newlyKnown[1].c7_eps_uv=100;
assert.equal(verifyFixedTierBinding(boundedApplied.row,buildFixedTierContext({storeLinks:newlyKnown},{reportDate,costDoc:aliasCosts})).ok,false);
for(const invalidPeer of [{...boundedPeers[1],is_on_shelf:null},{...boundedPeers[1],c7_eps_uv:-1}]) {
 const invalidRows=structuredClone(boundedPeers);invalidRows[1]=invalidPeer;
 assert.equal(resolveFixedTierPrice(invalidRows[6],buildFixedTierContext({storeLinks:invalidRows},{reportDate})).blocked,true);
}
const hiddenPeer=structuredClone(boundedPeers);hiddenPeer[1].is_on_shelf=false;
// Cost evidence is required for a priced classification; omitting it now fails
// closed on cost rather than reaching the ranking evidence under test.
assert.equal(resolveFixedTierPrice(hiddenPeer[6],buildFixedTierContext({storeLinks:hiddenPeer},{reportDate,costDoc:aliasCosts})).binding.evidence.rank,6);
let checks=0;
function peers(canonical) {return Array.from({length:7},(_,i)=>({storeKey:'S'+i,skc:'k'+i,canonical,standard_goods_sn:canonical,is_on_shelf:true,c7_eps_uv:2900-i*100,c7_goods_uv:10,c7_cart_uv:0,c7_sale_cnt:0,shelf_age_days:30}));}
for (const [index,item] of standard.doc.items.entries()) {
  assert.deepEqual(item.prices,expected[index]);
  const costDoc={trueCostMap:{[item.canonical]:{unitCostSar:20,storageUnitCostSar:1}}};
  // The effective tier basis is the in-force reviewed workbook basis when the
  // canonical has one, otherwise the standard's own price list. Five canonicals
  // now carry one, and one of those is a full-cost-margin basis.
  const workbookBasis=(standard.doc.reviewedWorkbookBases||[]).find(r=>reportDate>=r.effectiveDate&&r.canonical===item.canonical);
  const basis=workbookBasis?workbookBasis.basis:{kind:'price',tiers:item.prices};
  for(let tier=0;tier<3;tier++) {
    const rows=peers(item.canonical);
    const row=rows[tier===2?6:0];
    if(tier===0) Object.assign(row,{c7_eps_uv:4000,c7_goods_uv:200});
    const context=buildFixedTierContext({storeLinks:rows},{reportDate,costDoc});
    const d=resolveFixedTierPrice(row,context);
    assert.equal(d.blocked,false);
    assert.equal(d.binding.tier,tier);
    // Variation samples within the approved range around the effective basis.
    const range=basis.kind==='price'?PRICE_VARIATION_POLICY.price:PRICE_VARIATION_POLICY.margin;
    const observed=basis.kind==='price'?d.price:d.binding.evidence.priceVariation.actualFullMargin;
    assert.ok(observed>=basis.tiers[tier]+range.min-1e-9 && observed<=basis.tiers[tier]+range.max+1e-9);
    const applied=applyFixedTierPrice({...row,targetPrice:1,finalTargetPrice:1},context);
    assert.equal(verifyFixedTierBinding(applied.row,context).ok,true);
    assert.equal(verifyFixedTierBinding({...applied.row,targetPrice:d.price-.01},context).ok,false);
    assert.equal(resolveFixedTierPrice({...row,platformMaximumActivityPrice:d.price-1},context).price,d.price-1);
    assert.equal(applyPlatformPriceConstraint({targetPrice:d.price,platformMaximum:d.price-1,fullUnitCostSar:10}).differenceSar,-1);
    assert.equal(verifyFixedTierBinding({...row,targetPrice:d.price},context).ok,false);
    const changed=structuredClone(standard);changed.doc.version='next';changed.sha256='f'.repeat(64);
    assert.equal(verifyFixedTierBinding(applied.row,buildFixedTierContext({storeLinks:rows},{reportDate,standard:changed})).ok,false);
    const lowContext=buildLowEtFastSellerPricingContext({linksDataDoc:{storeLinks:rows},inventoryTrendDoc:{},baselineDoc:{items:[]},costDoc,reportDate});
    const low=applyLowEtFastSellerPricePullback({row,context:lowContext});
    assert.equal(low.row.finalTargetPrice,d.price);assert.equal(low.audit.mode,'user_fixed_tier');
    assert.equal(revalidateLowEtFastSellerPricePullback({row:low.row,context:lowContext}).ok,true);
    if(tier===0) {
      // A priced high-click special requires complete cost evidence; an empty
      // cost map now fails closed with fixed_tier_pricing_blocked.
      const high=buildHighClickLowConversionSpecialAudit({linksDataDoc:{storeLinks:rows},inventoryTrendDoc:{},priceOverridesDoc:{items:[]},costDoc,manualRegistry:{entries:[]},reportDate,now:new Date(`${reportDate}T03:00:00Z`)});
      assert.equal(high.rows[0]?.specialPrice,d.price);assert.equal(high.rows[0].fixedTierPricing.ruleHash,standard.sha256);
    }
    checks+=12;
  }
}
assert.equal(fixedTierItem('KJ-102S三明治机'),null);
assert.equal(fixedTierItem('SK-GT-3065W蒸汽熨烫机'),null);
const rows=peers(standard.doc.items[0].canonical);
// Complete cost evidence is required for any priced classification; the item's
// own canonical must be present in the cost map.
const itemCostDoc={trueCostMap:{[standard.doc.items[0].canonical]:{unitCostSar:54.4737,storageUnitCostSar:.6201}}};
let ctx=buildFixedTierContext({storeLinks:rows},{reportDate,costDoc:itemCostDoc});
rows[0].c7_sale_cnt=null;
// On or after 2026-09-10 an unclassifiable link is priced by the reviewed tier
// fallback rather than blocking, so the tier stays provable while the missing
// metric stays visible in the evidence.
const unknownSales=resolveFixedTierPrice(rows[0],ctx);
assert.equal(unknownSales.blocked,false);
assert.equal(unknownSales.binding.evidence.pricingClassificationFallback.source,'ordinary_tier_without_classification');
rows[0].c7_sale_cnt=0;rows[0].c7_eps_uv=4000;rows[0].c7_goods_uv=null;rows[0].c7_cart_uv=0;
const unknownClicks=resolveFixedTierPrice(rows[0],ctx);
assert.equal(unknownClicks.blocked,false);
assert.equal(unknownClicks.binding.evidence.pricingClassificationFallback.source,'ordinary_tier_without_classification');
rows[0].c7_cart_uv=20;
// The cart-visitor route qualifies the link for the high-click tier, whose
// approved baseline for this canonical is 83.54.
const cartRoute=resolveFixedTierPrice(rows[0],ctx);
assert.equal(cartRoute.binding.tier,0);
assert.ok(Math.abs(cartRoute.price-83.54)<=2);
const exception=structuredClone(standard);exception.doc.exceptions=[{canonical:rows[0].canonical,storeKey:'S0',skc:'k0',price:83,authorizedAt:'2026-09-09',authorization:'user-explicit-later-instruction'}];exception.sha256='a'.repeat(64);
// A user exception must be authorized at or after the standard's effectiveDate.
exception.doc.exceptions=[{canonical:rows[0].canonical,storeKey:'S0',skc:'k0',price:83,authorizedAt:'2026-09-16',authorization:'user-explicit-later-instruction'}];
assert.equal(resolveFixedTierPrice(rows[0],buildFixedTierContext({storeLinks:rows},{reportDate,costDoc:itemCostDoc,standard:exception})).price,83);
const missingCanonical='MISSING-123测试品';
const missingRows=peers(missingCanonical);
const missingStandard=structuredClone(standard);missingStandard.doc.missingStandardMargins.confirmedMissingCanonicals=[{canonical:missingCanonical,evidenceSha256:'c'.repeat(64),sourceVersion:'fixture-complete-standards'}];
const costs={trueCostMap:{[missingCanonical]:{unitCostSar:80,storageUnitCostSar:20}}};
// Full-cost-margin targets for this fixture (unit 80 + storage 20).
for(const [tier,expectedPrice] of [129.29,132.73,144.71].entries()) {
 const cases=structuredClone(missingRows);const row=cases[tier===2?6:0];if(tier===0)Object.assign(row,{c7_eps_uv:4000,c7_goods_uv:200});
 const context=buildFixedTierContext({storeLinks:cases},{reportDate,costDoc:costs,standard:missingStandard});
 const decision=resolveFixedTierPrice(row,context);assert.equal(decision.price,expectedPrice);assert.equal(decision.binding.mode,'missing_standard_full_cost_margin');
 const capped=resolveFixedTierPrice({...row,platformMaximumActivityPrice:100},context);assert.equal(capped.price,100);assert.equal(capped.binding.platform.actualMargin,0);assert.equal(capped.binding.originalTargetPrice,expectedPrice);
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard})).blocked,true);
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard,costDoc:{trueCostMap:{[missingCanonical]:{unitCostSar:80}}}})).reason,'pricing_missing_storage_cost');
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard,costDoc:costs,baselineDoc:{items:[{canonical:missingCanonical,targetPrice:88}]}})).applies,false);
}
// The pre-2026-09-10 fail-closed rule for an unverified missing standard only
// applies to a report date before that cutover, which is now earlier than the
// loaded standard's own effectiveDate. Pin it with an explicit standard so the
// guard stays covered instead of silently becoming unreachable.
const preCutover=structuredClone(standard);
preCutover.doc.effectiveDate='2026-09-08';
preCutover.sha256='b'.repeat(64);
assert.equal(resolveFixedTierPrice(missingRows[0],buildFixedTierContext({storeLinks:missingRows},{reportDate:'2026-09-09',costDoc:costs,standard:preCutover})).reason,'existing_user_standard_coverage_unverified');
// On or after the cutover an unverified canonical is priced from the missing-
// standard margin tiers rather than blocking, with execution still gated on
// live identity/inventory/membership.
assert.equal(resolveFixedTierPrice(missingRows[0],buildFixedTierContext({storeLinks:missingRows},{reportDate,costDoc:costs})).binding.mode,'missing_standard_full_cost_margin');
const pa4=standard.doc.inheritedStandards.find(r=>r.canonical.startsWith('PA4-6L'));
assert.equal(pa4.top5Margin,.45);assert.equal(pa4.regularMargin,.48);
const pa4Links=peers(pa4.canonical);const pa4Costs={trueCostMap:{[pa4.canonical]:{unitCostSar:80,storageUnitCostSar:6.64}}};
const pa4Context=buildFixedTierContext({storeLinks:pa4Links},{reportDate,costDoc:pa4Costs});
// PA4-6L便携式冰箱 now carries an approved fixed price list in the standard
// ([157.9,163.85,180.92]), so it resolves as fixed_sar instead of inheriting
// full-cost margins; the inherited margins remain recorded for reference.
assert.equal(resolveFixedTierPrice(pa4Links[0],pa4Context).binding.mode,'fixed_sar');
assert.equal(resolveFixedTierPrice(pa4Links[0],pa4Context).binding.tier,1);
assert.ok(Math.abs(resolveFixedTierPrice(pa4Links[0],pa4Context).price-163.85)<=2);
assert.equal(resolveFixedTierPrice(pa4Links[6],pa4Context).binding.tier,2);
assert.ok(Math.abs(resolveFixedTierPrice(pa4Links[6],pa4Context).price-180.92)<=2);
const executorSource=fs.readFileSync(new URL('./apply_hl_limited_discount_rescue.mjs',import.meta.url),'utf8');
const uiFunction=executorSource.slice(executorSource.indexOf('    function buildAddCostRows('),executorSource.indexOf('    function checkSkuPricePayload('));
const target={skc:'ui-test',limitedDiscountPrice:141,finalTargetPrice:141,fullUnitCostSar:100};
const build=new Function('targetRows','activityStock','pricingRuleHash','const round2=n=>Math.round(Number(n)*100)/100;'+uiFunction+';return buildAddCostRows;')([target],10,standard.sha256);
const built=build([{skc:'ui-test',supply_price_info:{supply_price:200,max_supply_price:120,intercept_supply_price:1},inventory_num:20,check_stock:{min_stock:1,max_stock:100},sku_info_list:[{id:1,sku:'sku-1',supply_price_info:{supply_price:200,max_supply_price:110}}]}],{});
assert.deepEqual(built.invalid,[]);assert.equal(target.limitedDiscountPrice,110);assert.equal(built.addRows[0].add_sku_list[0].product_act_price,110);assert.equal(target.platformPriceAudit.originalTargetPrice,141);assert.equal(target.platformPriceAudit.actualMargin,(110-100)/110);
assert.equal(verifyPlatformPriceAudit({...target,limitedDiscountPrice:141},target.platformPriceAudit)?.actualPrice,110);
assert.equal(verifyPlatformPriceAudit({...target,limitedDiscountPrice:141},{...target.platformPriceAudit,actualPrice:111}),null);
// The executor also clamps UP to the platform's rate-intercept supply floor and
// records that adjustment. Verifying only the downward cap rejected every
// floor-raised row, so the audit the executor had just produced could never be
// written back and the recorded special price stayed permanently out of step
// with the live platform price.
const floorRow={skc:'floor-1',limitedDiscountPrice:115.62,specialPrice:115.62};
const floorAudit={ruleHash:standard.sha256,skc:'floor-1',originalTargetPrice:115.62,actualPrice:120.01,platformMaximum:570,differenceSar:4.39,platformFloor:120,platformFloorAdjustment:{skc:'floor-1',requestedPrice:115.62,interceptSupplyPrice:120,adjustedPrice:120.01}};
assert.equal(verifyPlatformPriceAudit(floorRow,floorAudit)?.actualPrice,120.01);
for(const tampered of [
  {...floorAudit,actualPrice:121},
  {...floorAudit,differenceSar:5},
  {...floorAudit,platformFloor:null},
  {...floorAudit,platformFloor:118},
  {...floorAudit,platformFloorAdjustment:{...floorAudit.platformFloorAdjustment,skc:'other'}},
  {...floorAudit,platformFloorAdjustment:{...floorAudit.platformFloorAdjustment,requestedPrice:100}},
]) assert.equal(verifyPlatformPriceAudit(floorRow,tampered),null,'a tampered floor audit must be rejected');
const historical446=peers('SK-446');
// SK-446 now carries an approved reviewed-workbook price basis, so it prices
// from that basis (and still fails closed without complete cost evidence)
// rather than requiring a separate reconciliation step.
const historical446NoCost=resolveFixedTierPrice(historical446[0],buildFixedTierContext({storeLinks:historical446},{reportDate}));
assert.equal(historical446NoCost.blocked,true);
assert.equal(historical446NoCost.reason,'pricing_missing_or_ambiguous_product_cost');
const historical446Cost={trueCostMap:{'SK-446':{unitCostSar:80,storageUnitCostSar:5}}};
const historical446Priced=resolveFixedTierPrice(historical446[0],buildFixedTierContext({storeLinks:historical446},{reportDate,costDoc:historical446Cost}));
assert.equal(historical446Priced.blocked,false);
assert.equal(historical446Priced.binding.mode,'inherited_reviewed_workbook_basis');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'fixed-tier-registry-'));
try {
 const registry=path.join(fixture,'registry.json'),receipt=path.join(fixture,'receipt.json');
 fs.writeFileSync(registry,JSON.stringify({entries:[]}));
 const cli=fileURLToPath(new URL('./manage_manual_limited_discount_override.mjs',import.meta.url));
 const run=(...args)=>{const r=spawnSync(process.execPath,[cli,...args,'--registry',registry],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 run('register','--store','FIXTURE','--skc','ui-test','--special-price','141','--valid-from','2026-09-08 00:00:00','--valid-to','2026-09-15 23:59:59','--activity-stock','10','--reason','offline fixture','--source-thread-id','fixture','--source-artifact','fixture');
 fs.writeFileSync(receipt,JSON.stringify({ok:true,platformPriceAudits:[target.platformPriceAudit]}));
 run('update-activity','--store','FIXTURE','--skc','ui-test','--activity-id','123','--readback-artifact',receipt);
 const saved=JSON.parse(fs.readFileSync(registry)).entries[0];assert.equal(saved.specialPrice,110);assert.equal(saved.originalSpecialPrice,141);
} finally {assert.equal(path.dirname(fixture),os.tmpdir());fs.rmSync(fixture,{recursive:true,force:true});}
console.log(JSON.stringify({ok:true,fixedProductTierCases:standard.doc.items.length*3,missingStandardTierCases:3,products:standard.doc.items.length,tiers:3,ruleVersion:standard.doc.version,ruleHash:standard.sha256,productionWrites:0},null,2));
