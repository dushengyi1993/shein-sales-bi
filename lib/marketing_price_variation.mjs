import {createHash} from 'node:crypto';

export const PRICE_VARIATION_POLICY = Object.freeze({
  version:'marketing-link-variation/2026-09-09.1', effectiveDate:'2026-09-09',
  price:Object.freeze({min:-2,max:1}), margin:Object.freeze({min:-.02,max:.01}),
});
const stable = value => Array.isArray(value)?value.map(stable):value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const finite = value => typeof value === 'number' && Number.isFinite(value);
const ceilCents = value => Math.ceil(value*100-1e-8);
const floorCents = value => Math.floor(value*100+1e-8);
const roundCents = value => Math.round((value+Number.EPSILON)*100);

export function priceVariationSeed(row,businessDate) {
  const store=String(row?.storeKey ?? row?.store_key ?? '').trim().toUpperCase();
  const skc=String(row?.skc ?? '').trim().toLowerCase();
  const label=String(row?.canonical ?? row?.standard_goods_sn ?? '').normalize('NFKC').trim();
  const canonical=label.match(/^[A-Za-z0-9-]+/)?.[0].replaceAll('-','').toUpperCase() || label;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(businessDate || '') || !store || !skc || !canonical) throw Error('price_variation_scope_missing');
  return JSON.stringify([businessDate,store,String(row?.activityId ?? ''),skc,canonical]);
}

export function validateVariationBasis(basis) {
  if(!['price','full_cost_margin'].includes(basis?.kind) || basis.tiers?.length!==3
    || basis.tiers.some(value=>!finite(value) || (basis.kind==='price' ? value<=0 : value>=1))
    || basis.tiers.some((value,index)=>index>0 && value<basis.tiers[index-1])) throw Error('price_variation_basis_invalid');
  if(basis.minimumMargins!==undefined && (basis.kind!=='full_cost_margin' || basis.minimumMargins?.length!==3
    || basis.minimumMargins.some(value=>!finite(value) || value>=1))) throw Error('price_variation_margin_floor_invalid');
  return basis;
}

// Resolve once while preparing a new unit. Verification reuses these exact
// inputs; no wall clock/random source or second integer-price jitter is used.
export function resolveTierPriceVariation({basis,tier,fullUnitCostSar,seedKey,platformMaximum=null}={}) {
  validateVariationBasis(basis);
  if(![0,1,2].includes(tier) || !finite(fullUnitCostSar) || fullUnitCostSar<=0 || !seedKey
    || (platformMaximum!==null && (!finite(platformMaximum) || platformMaximum<=0))) throw Error('price_variation_inputs_invalid');
  const priceMode=basis.kind==='price';
  const range=priceMode?PRICE_VARIATION_POLICY.price:PRICE_VARIATION_POLICY.margin;
  const baselinePrices=basis.tiers.map(value=>priceMode?value:fullUnitCostSar/(1-value));
  const baseline=basis.tiers[tier];
  const minimumMargin=basis.minimumMargins?.[tier] ?? .15;
  const lower=priceMode?baseline+range.min:fullUnitCostSar/(1-Math.max(minimumMargin,baseline+range.min));
  const upper=priceMode?baseline+range.max:fullUnitCostSar/(1-Math.min(.95,baseline+range.max));
  let minimumCents=Math.max(1,ceilCents(lower)),maximumCents=floorCents(upper);
  // Disjoint bands preserve tier order even across links with different seeds.
  // Equal user baselines may meet at the same cent; platform caps may also tie.
  if(tier>0) {
    const equal=baselinePrices[tier-1]===baselinePrices[tier];
    const cut=equal?roundCents(baselinePrices[tier]):Math.floor((baselinePrices[tier-1]+baselinePrices[tier])*50);
    minimumCents=Math.max(minimumCents,cut+(equal?0:1));
  }
  if(tier<2) {
    const equal=baselinePrices[tier]===baselinePrices[tier+1];
    const cut=equal?roundCents(baselinePrices[tier]):Math.floor((baselinePrices[tier]+baselinePrices[tier+1])*50);
    maximumCents=Math.min(maximumCents,cut);
  }
  if(minimumCents>maximumCents) throw Error('price_variation_tier_range_empty');
  const seedHash=hash([PRICE_VARIATION_POLICY.version,seedKey]);
  const fraction=parseInt(seedHash.slice(0,8),16)/0x100000000;
  const proposed=baseline+range.min+(range.max-range.min)*fraction;
  const rawPrice=priceMode?proposed:fullUnitCostSar/(1-proposed);
  const prePlatformPrice=Math.min(maximumCents,Math.max(minimumCents,roundCents(rawPrice)))/100;
  const price=platformMaximum===null?prePlatformPrice:Math.min(prePlatformPrice,floorCents(platformMaximum)/100);
  if(price<=0) throw Error('price_variation_platform_price_invalid');
  const record={schemaVersion:'marketing-price-variation/v1',policyVersion:PRICE_VARIATION_POLICY.version,
    seedKey,seedHash,basis:structuredClone(basis),tier,fullUnitCostSar,baselineValue:baseline,baselinePrice:baselinePrices[tier],
    minimumCents,maximumCents,prePlatformPrice,platformMaximum,price,
    effectiveOffset:priceMode?prePlatformPrice-baseline:(prePlatformPrice-fullUnitCostSar)/prePlatformPrice-baseline,
    actualFullMargin:(price-fullUnitCostSar)/price,platformAdjusted:price!==prePlatformPrice};
  return {...record,resolutionHash:hash(record)};
}

export function verifyTierPriceVariation(record) {
  if(record?.schemaVersion!=='marketing-price-variation/v1' || record.policyVersion!==PRICE_VARIATION_POLICY.version) return false;
  try {
    const current=resolveTierPriceVariation(record);
    return record.resolutionHash===current.resolutionHash && hash({...record,resolutionHash:undefined})===hash({...current,resolutionHash:undefined});
  } catch { return false; }
}
