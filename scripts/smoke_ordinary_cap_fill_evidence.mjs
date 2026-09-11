import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {verifyOrdinaryCapFill} from '../lib/marketing_ordinary_cap_fill_evidence.mjs';
import {isOrdinaryPlatformTierRewriteAccepted} from '../lib/marketing_ordinary_platform_price_policy.mjs';
// Exercise production evidence ingestion and comparison without importing the
// CLI entrypoint (which would open store sessions). No production dependencies.
const source=fs.readFileSync(new URL('marketing/verify_ordinary_activity_enrollment.mjs',import.meta.url),'utf8');
const evidenceSource=source.slice(source.indexOf('function evaluateFillEvidenceDoc('),source.indexOf('function extractFillResultDocFor('));
const compareSource=source.slice(source.indexOf('function comparePrice('),source.indexOf('async function verifyStore('));
const createVerifier=new Function('path','ROOT','args','verifyOrdinaryCapFill','isOrdinaryPlatformTierRewriteAccepted',evidenceSource+compareSource+';return {evaluateFillEvidenceDoc,compareWithFillEvidence};');
function compare(doc,expected,actual){
 const v=createVerifier(path,process.cwd(),{priceTolerance:.06,executionWorkFingerprint:expected.workFingerprint},verifyOrdinaryCapFill,isOrdinaryPlatformTierRewriteAccepted);
 const fillEvidence=v.evaluateFillEvidenceDoc(doc,'fixture.json',expected.storeKey,expected.activityId);
 return v.compareWithFillEvidence({actual,expected:expected.approvedPrice,fillEvidence,...expected});
}
// Numeric cases are captured from five 2026-09-11 submitted/read-back units.
const cases=[[113,121.7,10,109.53],[69.41,66.33,10,59.69],[68.13,67,10,60.3],[69.11,67,5,63.65],[69.28,66.33,5,63.01]];
let checks=0;
for(const [approved,current,min,price] of cases){
 const expected={storeKey:'TEST',activityId:42,skc:'fixture',approvedPrice:approved,workFingerprint:'a'.repeat(64)};
 const target={skc:'fixture',ok:true,currentPrice:current,minDiscount:min,targetPrice:price,targetPriceText:String(price),approvedTargetPrice:approved,activityTargetAfterPlatformAdjust:price,platformAdjusted:true,platformAdjustmentApplied:true,requiresReapproval:false,floorBreached:false,platformPricePolicy:'submit_platform_minimum_tier_and_audit',platformPriceAudit:{originalTargetPrice:approved,actualPrice:price,platformAdjusted:true}};
 const doc={store:'TEST',activity:{activityId:42},executionWorkFingerprint:'a'.repeat(64),ok:true,submit:{ok:true,submitted:true,state:{successUrl:true,pendingConfirm:false}},selection:{ok:true,selectedMatchesPlan:true,missingAllowedSkcs:[],outOfPlanRows:[]},fill:{ok:true,missingCost:[],mismatches:[],priceStackBlockers:[],outOfPlanRows:[],targets:[target]}};
 assert.equal(verifyOrdinaryCapFill(doc,expected).price,price);checks++;
 assert.equal(compare(doc,expected,null).fillTargetPrice,price);checks++;
 assert.equal(compare(doc,expected,price).ok,true);checks++;
 assert.equal(compare(doc,expected,price+1).ok,false);checks++;
 const mutations=[d=>d.store='OTHER',d=>d.activity.activityId=43,d=>d.executionWorkFingerprint='b'.repeat(64),d=>d.ok=false,d=>d.submit.submitted=false,d=>d.submit.ok=false,d=>d.submit.state.successUrl=false,d=>d.submit.state.pendingConfirm=true,d=>d.selection.ok=false,d=>d.selection.missingAllowedSkcs.push('missing'),d=>d.fill.mismatches.push({}),d=>d.fill.priceStackBlockers.push({}),d=>delete d.fill.missingCost,d=>d.fill.targets.push(structuredClone(target)),d=>d.fill.targets[0].skc='other',d=>d.fill.targets[0].minDiscount=99,d=>d.fill.targets[0].approvedTargetPrice+=1,d=>d.fill.targets[0].targetPriceText='0',d=>d.fill.targets[0].platformPriceAudit.actualPrice+=1,d=>d.fill.targets[0].requiresReapproval=true,d=>d.fill.targets[0].floorBreached=true,d=>d.fill.targets[0].platformPricePolicy='unknown'];
 for(const mutate of mutations){const bad=structuredClone(doc);mutate(bad);assert.equal(verifyOrdinaryCapFill(bad,expected).ok,false);checks++;assert.equal(compare(bad,expected,null).ok,false);checks++;}
 for(const bad of [{...expected,workFingerprint:''},{...expected,activityId:43},{...expected,storeKey:'OTHER'},{...expected,skc:'other'},{...expected,approvedPrice:approved+1}]){assert.equal(verifyOrdinaryCapFill(doc,bad).ok,false);checks++;}
}
console.log(JSON.stringify({ok:true,cases:cases.length,checks,networkCalls:0,businessWrites:0}));
