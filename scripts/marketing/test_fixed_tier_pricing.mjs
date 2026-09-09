import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {loadFixedTierStandard, fixedTierItem, fullTierCost, buildFixedTierContext, resolveFixedTierPrice, applyFixedTierPrice, verifyFixedTierBinding,applyPlatformPriceConstraint,verifyPlatformPriceAudit} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {buildLowEtFastSellerPricingContext, applyLowEtFastSellerPricePullback, revalidateLowEtFastSellerPricePullback} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {buildHighClickLowConversionSpecialAudit} from '../../lib/marketing_high_click_special_policy.mjs';

const standard=loadFixedTierStandard();
assert.equal(standard.doc.items.length,8);
const expected=[[84,88,92],[241,241,250],[141,145,149],[58,62,66],[81,86,91],[76,81,86],[132,138,144],[285,293,306]];
const reportDate='2026-09-08';
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
assert.equal(aliasApplied.row.fixedTierPricing.platform.actualPrice,91.88);
assert.ok(Math.abs(aliasApplied.row.fixedTierPricing.platform.actualMargin-(91.88-55.0938)/91.88)<1e-10);
assert.equal(verifyFixedTierBinding(aliasApplied.row,aliasContext).ok,true);
let checks=0;
function peers(canonical) {return Array.from({length:7},(_,i)=>({storeKey:'S'+i,skc:'k'+i,canonical,standard_goods_sn:canonical,is_on_shelf:true,c7_eps_uv:2900-i*100,c7_goods_uv:10,c7_cart_uv:0,c7_sale_cnt:0,shelf_age_days:30}));}
for (const [index,item] of standard.doc.items.entries()) {
  assert.deepEqual(item.prices,expected[index]);
  for(let tier=0;tier<3;tier++) {
    const rows=peers(item.canonical);
    const row=rows[tier===2?6:0];
    if(tier===0) Object.assign(row,{c7_eps_uv:4000,c7_goods_uv:200});
    const context=buildFixedTierContext({storeLinks:rows},{reportDate});
    const d=resolveFixedTierPrice(row,context);
    assert.equal(d.blocked,false);assert.equal(d.price,item.prices[tier]);assert.equal(d.binding.tier,tier);
    const applied=applyFixedTierPrice({...row,targetPrice:1,finalTargetPrice:1},context);
    assert.equal(verifyFixedTierBinding(applied.row,context).ok,true);
    assert.equal(verifyFixedTierBinding({...applied.row,targetPrice:d.price-.01},context).ok,false);
    assert.equal(resolveFixedTierPrice({...row,platformMaximumActivityPrice:d.price-1},context).price,d.price-1);
    assert.equal(applyPlatformPriceConstraint({targetPrice:d.price,platformMaximum:d.price-1,fullUnitCostSar:10}).differenceSar,-1);
    assert.equal(verifyFixedTierBinding({...row,targetPrice:d.price},context).ok,false);
    const changed=structuredClone(standard);changed.doc.version='next';changed.sha256='f'.repeat(64);
    assert.equal(verifyFixedTierBinding(applied.row,buildFixedTierContext({storeLinks:rows},{reportDate,standard:changed})).ok,false);
    const lowContext=buildLowEtFastSellerPricingContext({linksDataDoc:{storeLinks:rows},inventoryTrendDoc:{},baselineDoc:{items:[]},reportDate});
    const low=applyLowEtFastSellerPricePullback({row,context:lowContext});
    assert.equal(low.row.finalTargetPrice,d.price);assert.equal(low.audit.mode,'user_fixed_tier');
    assert.equal(revalidateLowEtFastSellerPricePullback({row:low.row,context:lowContext}).ok,true);
    if(tier===0) {
      const high=buildHighClickLowConversionSpecialAudit({linksDataDoc:{storeLinks:rows},inventoryTrendDoc:{},priceOverridesDoc:{items:[]},costDoc:{},manualRegistry:{entries:[]},reportDate,now:new Date('2026-09-08T03:00:00Z')});
      assert.equal(high.rows[0]?.specialPrice,d.price);assert.equal(high.rows[0].fixedTierPricing.ruleHash,standard.sha256);
    }
    checks+=12;
  }
}
assert.equal(fixedTierItem('KJ-102S三明治机'),null);
assert.equal(fixedTierItem('SK-GT-3065W蒸汽熨烫机'),null);
const rows=peers(standard.doc.items[0].canonical);
let ctx=buildFixedTierContext({storeLinks:rows},{reportDate});
rows[0].c7_sale_cnt=null;
assert.equal(resolveFixedTierPrice(rows[0],ctx).blocked,true);
rows[0].c7_sale_cnt=0;rows[0].c7_eps_uv=4000;rows[0].c7_goods_uv=null;rows[0].c7_cart_uv=0;
assert.equal(resolveFixedTierPrice(rows[0],ctx).reason,'fixed_tier_high_click_qualification_unknown');
rows[0].c7_cart_uv=20;
assert.equal(resolveFixedTierPrice(rows[0],ctx).price,84);
const exception=structuredClone(standard);exception.doc.exceptions=[{canonical:rows[0].canonical,storeKey:'S0',skc:'k0',price:83,authorizedAt:'2026-09-09',authorization:'user-explicit-later-instruction'}];exception.sha256='a'.repeat(64);
assert.equal(resolveFixedTierPrice(rows[0],buildFixedTierContext({storeLinks:rows},{reportDate,standard:exception})).price,83);
const missingCanonical='MISSING-123测试品';
const missingRows=peers(missingCanonical);
const missingStandard=structuredClone(standard);missingStandard.doc.missingStandardMargins.confirmedMissingCanonicals=[{canonical:missingCanonical,evidenceSha256:'c'.repeat(64),sourceVersion:'fixture-complete-standards'}];
const costs={trueCostMap:{[missingCanonical]:{unitCostSar:80,storageUnitCostSar:20}}};
for(const [tier,expectedPrice] of [129.88,133.34,142.86].entries()) {
 const cases=structuredClone(missingRows);const row=cases[tier===2?6:0];if(tier===0)Object.assign(row,{c7_eps_uv:4000,c7_goods_uv:200});
 const context=buildFixedTierContext({storeLinks:cases},{reportDate,costDoc:costs,standard:missingStandard});
 const decision=resolveFixedTierPrice(row,context);assert.equal(decision.price,expectedPrice);assert.equal(decision.binding.mode,'missing_standard_full_cost_margin');
 const capped=resolveFixedTierPrice({...row,platformMaximumActivityPrice:100},context);assert.equal(capped.price,100);assert.equal(capped.binding.platform.actualMargin,0);assert.equal(capped.binding.originalTargetPrice,expectedPrice);
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard})).blocked,true);
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard,costDoc:{trueCostMap:{[missingCanonical]:{unitCostSar:80}}}})).reason,'pricing_missing_storage_cost');
 assert.equal(resolveFixedTierPrice(row,buildFixedTierContext({storeLinks:cases},{reportDate,standard:missingStandard,costDoc:costs,baselineDoc:{items:[{canonical:missingCanonical,targetPrice:88}]}})).applies,false);
}
assert.equal(resolveFixedTierPrice(missingRows[0],buildFixedTierContext({storeLinks:missingRows},{reportDate,costDoc:costs})).reason,'existing_user_standard_coverage_unverified');
const pa4=standard.doc.inheritedStandards.find(r=>r.canonical.startsWith('PA4-6L'));
assert.equal(pa4.top5Margin,.45);assert.equal(pa4.regularMargin,.48);
const pa4Links=peers(pa4.canonical);const pa4Costs={trueCostMap:{[pa4.canonical]:{unitCostSar:80,storageUnitCostSar:6.64}}};
const pa4Context=buildFixedTierContext({storeLinks:pa4Links},{reportDate,costDoc:pa4Costs});
assert.equal(resolveFixedTierPrice(pa4Links[0],pa4Context).price,157.53);
assert.equal(resolveFixedTierPrice(pa4Links[6],pa4Context).price,166.62);
const executorSource=fs.readFileSync(new URL('./apply_hl_limited_discount_rescue.mjs',import.meta.url),'utf8');
const uiFunction=executorSource.slice(executorSource.indexOf('    function buildAddCostRows('),executorSource.indexOf('    function checkSkuPricePayload('));
const target={skc:'ui-test',limitedDiscountPrice:141,finalTargetPrice:141,fullUnitCostSar:100};
const build=new Function('targetRows','activityStock','pricingRuleHash','const round2=n=>Math.round(Number(n)*100)/100;'+uiFunction+';return buildAddCostRows;')([target],10,standard.sha256);
const built=build([{skc:'ui-test',supply_price_info:{supply_price:200,max_supply_price:120,intercept_supply_price:1},inventory_num:20,check_stock:{min_stock:1,max_stock:100},sku_info_list:[{id:1,sku:'sku-1',supply_price_info:{supply_price:200,max_supply_price:110}}]}],{});
assert.deepEqual(built.invalid,[]);assert.equal(target.limitedDiscountPrice,110);assert.equal(built.addRows[0].add_sku_list[0].product_act_price,110);assert.equal(target.platformPriceAudit.originalTargetPrice,141);assert.equal(target.platformPriceAudit.actualMargin,(110-100)/110);
assert.equal(verifyPlatformPriceAudit({...target,limitedDiscountPrice:141},target.platformPriceAudit)?.actualPrice,110);
assert.equal(verifyPlatformPriceAudit({...target,limitedDiscountPrice:141},{...target.platformPriceAudit,actualPrice:111}),null);
const historical446=peers('SK-446');
assert.equal(resolveFixedTierPrice(historical446[0],buildFixedTierContext({storeLinks:historical446},{reportDate})).reason,'existing_user_standard_requires_latest_reconciliation');
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
console.log(JSON.stringify({ok:true,fixedProductTierCases:24,missingStandardTierCases:3,products:8,tiers:3,ruleVersion:standard.doc.version,ruleHash:standard.sha256,productionWrites:0},null,2));
