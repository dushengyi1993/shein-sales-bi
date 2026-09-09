import assert from 'node:assert/strict';
import {PRICE_VARIATION_POLICY,priceVariationSeed,resolveTierPriceVariation,verifyTierPriceVariation} from '../../lib/marketing_price_variation.mjs';
import {loadFixedTierStandard,buildFixedTierContext,resolveFixedTierPrice,applyFixedTierPrice,verifyFixedTierBinding} from '../../lib/marketing_fixed_tier_pricing.mjs';
const standard=loadFixedTierStandard();
let checks=0;
const bases=[...standard.doc.items.map(item=>({kind:'price',tiers:item.prices})),
  {kind:'price',tiers:[91.53,91.53,97.25]},
  {kind:'full_cost_margin',tiers:[.23,.25,.30]}];
for(const basis of bases) {
  const byTier=[[],[],[]];
  for(let i=0;i<250;i++) for(let tier=0;tier<3;tier++) {
    const args={basis,tier,fullUnitCostSar:50,seedKey:priceVariationSeed({storeKey:`S${i}`,activityId:123,skc:`k${i}`,canonical:'fixture'},'2026-09-09')};
    const value=resolveTierPriceVariation(args);
    assert.deepEqual(resolveTierPriceVariation(args),value);
    assert.equal(verifyTierPriceVariation(JSON.parse(JSON.stringify(value))),true);
    const range=basis.kind==='price'?PRICE_VARIATION_POLICY.price:PRICE_VARIATION_POLICY.margin;
    assert.ok(value.effectiveOffset>=range.min-1e-9 && value.effectiveOffset<=range.max+1e-9);
    assert.equal(value.prePlatformPrice,value.price);
    byTier[tier].push(value.price);checks++;
  }
  for(let tier=0;tier<2;tier++) {
    const max=Math.max(...byTier[tier]),min=Math.min(...byTier[tier+1]);
    assert.ok(basis.tiers[tier]===basis.tiers[tier+1]?max<=min:max<min);
  }
  assert.ok(new Set(byTier.flat()).size>3,'different links should not all share one quote');
}
const ordinaryBasis={kind:'full_cost_margin',tiers:[.23,.25,.30]};
const input={basis:ordinaryBasis,tier:1,fullUnitCostSar:100,seedKey:'frozen-unit'};
const original=resolveTierPriceVariation(input),snapshot=JSON.stringify(original);
const capped=resolveTierPriceVariation({...input,platformMaximum:90.005});
assert.equal(capped.price,90);assert.equal(capped.platformAdjusted,true);
assert.equal(capped.prePlatformPrice,original.prePlatformPrice,'cap must not sample another offset');
assert.equal(verifyTierPriceVariation({...original,price:original.price+.01}),false);
assert.equal(verifyTierPriceVariation({...original,basis:{...ordinaryBasis,tiers:[.24,.26,.31]}}),false);
resolveTierPriceVariation({...input,seedKey:'next-unit',fullUnitCostSar:101});
assert.equal(JSON.stringify(original),snapshot,'preparing another unit must not rewrite a frozen unit');
assert.equal(verifyTierPriceVariation(original),true);
assert.throws(()=>resolveTierPriceVariation({...input,basis:{kind:'price',tiers:[80,70,90]}}),/basis_invalid/);
assert.throws(()=>resolveTierPriceVariation({...input,fullUnitCostSar:null}),/inputs_invalid/);
const floor=resolveTierPriceVariation({...input,basis:{kind:'full_cost_margin',tiers:[.15,.2,.3]},tier:0});
assert.ok(floor.actualFullMargin>=.15-1e-9);

// Actual shared binding path for all eight products, with complete cost.
for(const item of standard.doc.items) {
  const rows=Array.from({length:7},(_,i)=>({storeKey:`S${i}`,skc:`k${i}`,activityId:123,canonical:item.canonical,is_on_shelf:true,
    shelf_age_days:30,c7_eps_uv:2900-i*100,c7_goods_uv:10,c7_cart_uv:0,c7_sale_cnt:0}));
  const costDoc={trueCostMap:{[item.canonical]:{unitCostSar:20,storageUnitCostSar:1}}};
  for(const tier of [0,1,2]) {
    const cases=structuredClone(rows),row=cases[tier===2?6:0];
    if(tier===0) Object.assign(row,{c7_eps_uv:4000,c7_goods_uv:200});
    const context=buildFixedTierContext({storeLinks:cases},{reportDate:'2026-09-09',costDoc});
    const value=applyFixedTierPrice(row,context);
    assert.equal(value.blocked,false);
    assert.equal(value.row.fixedTierPricing.priceVariation.baselineValue,item.prices[tier]);
    assert.equal(verifyFixedTierBinding(value.row,context).ok,true);
    assert.ok(value.row.targetPrice>=item.prices[tier]-2 && value.row.targetPrice<=item.prices[tier]+1);
    const priorContext=buildFixedTierContext({storeLinks:cases},{reportDate:'2026-09-08',costDoc});
    const prior=applyFixedTierPrice(row,priorContext).row,priorSnapshot=JSON.stringify(prior);
    assert.equal(verifyFixedTierBinding(prior,context).ok,false);
    assert.equal(JSON.stringify(prior),priorSnapshot,'old locked/submitted price must not be changed by verification');
    checks++;
  }
}
console.log(JSON.stringify({ok:true,checks,productionWrites:0,priceRange:[-2,1],marginPointsRange:[-2,1],tierBandsOrdered:true,frozenUnitsPreserved:true}));
