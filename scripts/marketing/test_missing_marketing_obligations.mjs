#!/usr/bin/env node
// Offline: disposable local fixtures, no API/browser/production commands.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildMarketingObligationLedger} from '../../lib/marketing_obligation_ledger.mjs';
import {buildFixedTierContext,classifyFixedTierLink,applyFixedTierPrice,verifyFixedTierRescue,resolveFixedTierPrice} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {revalidateLowEtFastSellerRescueArtifact} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const tmpRoot=path.join(root,'tmp');await fs.mkdir(tmpRoot,{recursive:true});
const dir=await fs.mkdtemp(path.join(tmpRoot,'missing-marketing-fixture-'));
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const reportDate=today<'2026-09-10'?'2026-09-10':today;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try {
  const roster=Array.from({length:375},(_,i)=>({storeKey:'FIXTURE',skc:`test-${i<208?i%104:i}`,activityId:i<104?53585:i<208?53593:53616,
    canonical:'HS-025直发夹板',deadline:i<208?'2026-09-09 23:59:59':'2099-09-10 23:59:59',selected:false,reason:'exposure_missing'}));
  const asOf='2026-09-10T04:00:00+08:00';
  const initial=buildMarketingObligationLedger({roster,asOf});
  assert.equal(initial.counts.total,375);assert.equal(initial.counts.uniqueLinks,271);assert.equal(initial.counts.unfinished,375);assert.equal(initial.complete,false);
  assert.equal(initial.rows.filter(r=>r.nextAction==='check_price_stack_and_complete_limited_fallback').length,208);
  const observation={...roster[0],state:'limited_confirmed',officialReadback:true,identityMatched:true,priceMatched:true,
    inventoryState:'restored',receiptPath:'fixture-official-readback.json',receiptSha256:'a'.repeat(64),readbackAt:asOf,
    validFrom:'2026-09-10 03:00:00',validTo:'2026-09-17 23:59:59'};
  const covered=buildMarketingObligationLedger({roster,asOf,observations:[observation]});
  assert.equal(covered.counts.limitedFallbackConfirmed,2);assert.equal(covered.counts.unfinished,373);
  for (const edit of [{officialReadback:false},{identityMatched:false},{priceMatched:false},{inventoryState:'pending'},
    {canonical:'OTHER'},{validTo:'2026-09-09 23:59:59'},{validFrom:'2026-09-11 00:00:00'}]) {
    assert.equal(buildMarketingObligationLedger({roster,asOf,observations:[{...observation,...edit}]}).counts.unfinished,375);
  }
  const pending=buildMarketingObligationLedger({roster,asOf,observations:[{...roster[0],submissionState:'unknown',reason:'receipt_pending'}]});
  assert.equal(pending.rows[0].ordinarySubmissionLocked,true);assert.equal(pending.rows[0].nextAction,'read_back_original_submission_without_retry');
  assert.throws(()=>buildMarketingObligationLedger({roster:[]}),/roster_required/);

  const canonical='HS-025直发夹板';
  const costDoc={trueCostMap:{[canonical]:{productUnitCostSar:41,storageUnitCostSar:.12}}};
  const links={generatedAt:new Date().toISOString(),storeLinks:[],classificationCoverageComplete:false};
  const context=buildFixedTierContext(links,{reportDate,costDoc});
  const seed={storeKey:'JY',skc:'fixture-missing-link',canonical};
  const classification=classifyFixedTierLink(seed,context);
  assert.equal(classification.tier,2);assert.equal(classification.metrics.exposure,null);assert.equal(classification.metrics.sales,null);
  const applied=applyFixedTierPrice(seed,context);
  assert.equal(applied.blocked,false);assert.equal(applied.row.fixedTierPricing.mode,'inherited_reviewed_workbook_basis');
  assert.equal(applied.row.fixedTierPricing.priceVariation.baselinePrice,58.58);
  assert.equal(resolveFixedTierPrice({...seed,platformMaximumActivityPrice:40},context).price,40);
  const conflicting=buildFixedTierContext({storeLinks:[{...seed,canonical:'OTHER'}]},{reportDate,costDoc});
  assert.equal(classifyFixedTierLink(seed,conflicting).reason,'fixed_tier_link_identity_changed');
  assert.equal(resolveFixedTierPrice(seed,buildFixedTierContext(links,{reportDate})).blocked,true,'missing true cost still requires repair');
  const priorDoc={executionStatus:'user_approved_pending_execution',planMetadata:{workFingerprint:'b'.repeat(64)},items:[applied.row]};
  const prior=buildFixedTierContext(links,{reportDate,costDoc,baselineDoc:priorDoc});
  assert.equal(classifyFixedTierLink(seed,prior).pricingClassificationFallback.source,'approved_baseline_tier');
  const write=async(name,value)=>{const p=path.join(dir,name);await fs.writeFile(p,JSON.stringify(value));return p;};
  const linksFile=await write('links.json',links),costFile=await write('cost.json',costDoc),baselineFile=await write('baseline.json',{items:[]});
  const inventoryFile=await write('inventory.json',{products:[]}),policyFile=await write('policy.json',{});
  const historyDir=path.join(dir,'history');await fs.mkdir(historyDir);
  const storesFile=await write('stores.json',{stores:[{storeKey:'JY',enabled:true}]});
  const rescue={rows:[applied.row],sourceLinksData:linksFile,sourceCostMap:costFile,sourcePriceOverrides:baselineFile,
    sourceInventoryTrend:inventoryFile,pricingPolicy:policyFile,sourceRawLinkHistory:historyDir,sourceStoresConfig:storesFile};
  if (today>='2026-09-10') {
    const fixed=await verifyFixedTierRescue({root,rescue,reportDate});assert.equal(fixed.ok,true,JSON.stringify(fixed));
    const low=await revalidateLowEtFastSellerRescueArtifact({root,rescue,reportDate});assert.equal(low.ok,true,JSON.stringify(low));
  }
  const requiredFile=await write('required.json',{rows:[seed]}),liveFile=await write('live.json',{ok:true,stores:[{storeKey:'JY',ok:true}],rows:[]});
  const manualFile=await write('manual.json',{entries:[]});
  const result=spawnSync(process.execPath,['scripts/marketing/build_new_listing_limited_discount_plan.mjs',
    '--date',reportDate,'--now',reportDate+' 12:00:00','--required-roster',requiredFile,'--links-data',linksFile,
    '--price-overrides',baselineFile,'--expected-price-overrides-sha256',sha(await fs.readFile(baselineFile)),
    '--cost-map',costFile,'--inventory-trend',inventoryFile,'--stores-config',storesFile,'--link-history-dir',historyDir,
    '--current-marketing-live-scan',liveFile,'--manual-limited-discount-registry',manualFile,
    '--out-dir',path.join(dir,'rescue'),'--report-json',path.join(dir,'report.json'),'--report-md',path.join(dir,'report.md')],
    {cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr || result.stdout);
  const report=JSON.parse(await fs.readFile(path.join(dir,'report.json'),'utf8'));
  assert.equal(report.totals.requiredRoster,1);assert.equal(report.requiredRosterOutcomes.length,1);
  assert.equal(report.rows.length,1,JSON.stringify({blocked:report.blocked,ignored:report.ignored}));
  assert.equal(report.rows[0].requiresLiveEligibility,true);assert.equal(report.rows[0].fixedTierPricing.tier,2);
  console.log(JSON.stringify({ok:true,rosterRows:375,uniqueLinks:271,expiredRows:208,sharedConsumers:['price','limited rescue verifier','low ET verifier','required roster planner'],productionWrites:0}));
} finally {
  const relative=path.relative(tmpRoot,dir);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));await fs.rm(dir,{recursive:true,force:true});
}
