import assert from 'node:assert/strict';
import {loadFixedTierStandard, fixedTierItem, buildFixedTierContext, resolveFixedTierPrice, applyFixedTierPrice, verifyFixedTierBinding} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {buildLowEtFastSellerPricingContext, applyLowEtFastSellerPricePullback, revalidateLowEtFastSellerPricePullback} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {buildHighClickLowConversionSpecialAudit} from '../../lib/marketing_high_click_special_policy.mjs';

const standard=loadFixedTierStandard();
assert.equal(standard.doc.items.length,8);
const expected=[[84,88,92],[241,241,250],[141,145,149],[58,62,66],[81,86,91],[76,81,86],[132,138,144],[285,293,306]];
const reportDate='2026-09-08';
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
    assert.equal(verifyFixedTierBinding(applied.row,context,{platformMaximum:d.price-1}).reason,'fixed_tier_platform_maximum_below_fixed_price');
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
console.log(JSON.stringify({ok:true,checks:checks+6,products:8,tiers:3,ruleVersion:standard.doc.version,ruleHash:standard.sha256,productionWrites:0},null,2));
