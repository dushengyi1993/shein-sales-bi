#!/usr/bin/env node
// Offline: only disposable local files and the plan-lock CLI. No browser/API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadOrdinaryCampaignApproval,validateReviewedWorkbookPriceRows} from '../../lib/marketing_ordinary_campaign_approval.mjs';
import {buildFixedTierContext,classifyFixedTierLink,resolveFixedTierPrice,applyFixedTierPrice,verifyFixedTierBinding} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {buildLowEtFastSellerPricingContext,applyLowEtFastSellerPricePullback,revalidateLowEtFastSellerPricePullback} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const tempRoot=path.join(root,'tmp');
await fs.mkdir(tempRoot,{recursive:true});
const dir=await fs.mkdtemp(path.join(tempRoot,'reviewed-workbook-test-'));
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const workbook=Buffer.from('disposable workbook bytes, no production content');
const workbookSha256=crypto.createHash('sha256').update(workbook).digest('hex');
const workbookPath=path.join(dir,'fixture.xlsx');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
let checks=0;
function checkBlocked(row,ctx,reason) {
  const value=resolveFixedTierPrice(row,ctx);
  assert.equal(value.blocked,true,JSON.stringify(value));
  if(reason) assert.equal(value.reason,reason);
  checks++;
}
try {
  await fs.writeFile(workbookPath,workbook);
  const products=[
    ['KF-JN-02便携咖啡机',91.53,77,.8092,0],
    ['JD-389空气炸锅',120,70,2,2],
    ['SK-15030热风梳',80,40,2,1],
    ['SK-446电动刀与切片器',70,35,1,2],
    ['SK-1714-5手持搅拌器',64.26,48.02,1.46,0],
    ['SK-1714-5手持搅拌器',65.98,48.02,1.46,1],
    ['SK-1714-5手持搅拌器',70.69,48.02,1.46,2],
    ['BY-506S空气炸锅',225.40,169,.0502,1],
    ['KF-JN-02便携咖啡机',97.25,77,.8092,2],
  ];
  const rows=products.map(([canonical,targetPrice,cost,storageUnitCostSar,tier],index)=>({
    storeKey:'FIXTURE',activityId:123,skc:`fixture-${index}`,canonical,targetPrice,finalTargetPrice:targetPrice,cost,storageUnitCostSar,
    userExplicitCurrentPriceOverride:true,
    reviewedWorkbookPrice:{schemaVersion:'ordinary-reviewed-workbook-price/v1',workbookSha256,businessDate:date,tier,targetPrice,sourceCells:[`价格表!I${index+2}`],reason:'fixture current workbook decision'},
  }));
  const links=[];
  for(const row of rows) {
    const tier=row.reviewedWorkbookPrice.tier;
    links.push({...row,is_on_shelf:true,shelf_age_days:30,c7_eps_uv:tier===0?4000:tier===1?2000:100,c7_goods_uv:tier===0?200:1,c7_cart_uv:0,c7_sale_cnt:tier===0?0:1});
    if(tier===2) for(let i=0;i<5;i++) links.push({...row,storeKey:'PEER',skc:`${row.skc}-${i}`,is_on_shelf:true,shelf_age_days:30,c7_eps_uv:1000+i,c7_goods_uv:1,c7_cart_uv:0,c7_sale_cnt:1});
  }
  const costDoc={trueCostMap:Object.fromEntries(rows.map(row=>[row.canonical,{productUnitCostSar:row.cost,storageUnitCostSar:row.storageUnitCostSar}]))};
  const prices={items:rows},selection={items:rows.map(row=>({...row,selected:true}))};
  const selectionPath=path.join(dir,'selection.json'),pricesPath=path.join(dir,'prices.json');
  await fs.writeFile(selectionPath,JSON.stringify(selection));await fs.writeFile(pricesPath,JSON.stringify(prices));
  const lock=spawnSync(process.execPath,['scripts/marketing/lock_ordinary_campaign_execution_plan.mjs','--selection',selectionPath,'--prices',pricesPath,'--output-dir',path.join(dir,'locked'),'--label','fixture','--workbook-sha256',workbookSha256,'--reviewed-workbook',workbookPath,'--approval-text','fixture approved current workbook prices','--approval-source','offline disposable test'],{cwd:root,encoding:'utf8',windowsHide:true});
  assert.equal(lock.status,0,lock.stderr);
  const manifestPath=path.join(dir,'locked','approval-manifest-fixture.json');
  const approval=await loadOrdinaryCampaignApproval({root,manifestPath});
  const context=buildFixedTierContext({storeLinks:links},{reportDate:date,costDoc,baselineDoc:prices,reviewedWorkbookPriceCapability:approval.reviewedWorkbookPriceCapability});
  for(const row of rows) {
    const current=resolveFixedTierPrice(row,context);
    assert.equal(classifyFixedTierLink(row,context).tier,row.reviewedWorkbookPrice.tier);
    assert.equal(current.blocked,false,JSON.stringify(current));assert.equal(current.price,row.targetPrice);
    assert.equal(current.binding.mode,'reviewed_workbook_price');
    assert.equal(current.binding.evidence.reviewedWorkbookPrice.workFingerprint,approval.workFingerprint);
    assert.equal(verifyFixedTierBinding(row,context).ok,true);
    const lowEtContext=buildLowEtFastSellerPricingContext({linksDataDoc:{storeLinks:links},baselineDoc:prices,costDoc,reportDate:date,reviewedWorkbookPriceCapability:approval.reviewedWorkbookPriceCapability});
    const applied=applyLowEtFastSellerPricePullback({row,context:lowEtContext,costDoc});
    assert.equal(applied.blocked,false);assert.equal(applied.row.targetPrice,row.targetPrice);
    assert.equal(revalidateLowEtFastSellerPricePullback({row:applied.row,context:lowEtContext,costDoc}).ok,true);
    checks++;
  }
  const row=rows[0];
  const noDefault=structuredClone(context.standard);delete noDefault.doc.missingStandardMargins;
  assert.equal(resolveFixedTierPrice(rows[4],{...context,standard:noDefault}).price,rows[4].targetPrice);checks++;
  for(const edit of [{cost:null},{storageUnitCostSar:null},{manualSpecialLimitedDiscount:true},
    {reviewedWorkbookPrice:{...row.reviewedWorkbookPrice,targetPrice:91.531}},
    {reviewedWorkbookPrice:{...row.reviewedWorkbookPrice,sourceCells:[]}},
    {reviewedWorkbookPrice:{...row.reviewedWorkbookPrice,workbookSha256:'0'.repeat(64)}}]) {
    assert.throws(()=>validateReviewedWorkbookPriceRows([{...row,...edit}],{workbookSha256,businessDate:date}));checks++;
  }
  checkBlocked(row,{...context,reviewedWorkbookPriceCapability:null},'reviewed_workbook_price_requires_current_approval');
  checkBlocked(row,{...context,reviewedWorkbookPriceCapability:{...approval.reviewedWorkbookPriceCapability}},'reviewed_workbook_price_requires_current_approval');
  checkBlocked(row,{...context,reportDate:'2099-01-01'},'reviewed_workbook_price_date_changed');
  for(const edit of [{storeKey:'OTHER'},{activityId:124},{skc:'other'},{canonical:'OTHER'},{cost:78},{storageUnitCostSar:0},
    {reviewedWorkbookPrice:{...row.reviewedWorkbookPrice,targetPrice:90}},
    {reviewedWorkbookPrice:{...row.reviewedWorkbookPrice,sourceCells:['other!I1']}},
    {reviewedWorkbookPrice:undefined},{manualSpecialLimitedDiscount:true}]) checkBlocked({...row,...edit},context);
  const changedPrice={...row,targetPrice:90};
  assert.equal(verifyFixedTierBinding(changedPrice,context).ok,false);
  assert.equal(applyFixedTierPrice(changedPrice,context).blocked,true);checks++;
  const liveKey=`${row.storeKey}::${row.skc}`;
  for(const edit of [{is_on_shelf:false},{c7_eps_uv:null},{c7_sale_cnt:1},{fixedTierDuplicateConflict:true}]) {
    const byKey=new Map(context.byKey);byKey.set(liveKey,{...byKey.get(liveKey),...edit});checkBlocked(row,{...context,byKey});
  }
  checkBlocked(row,{...context,costDoc:{trueCostMap:{[row.canonical]:{productUnitCostSar:77,storageUnitCostSar:.9}}}},'reviewed_workbook_price_cost_changed');
  const applied=applyFixedTierPrice(row,context).row;
  const changedLinks=new Map(context.byKey);changedLinks.set(liveKey,{...changedLinks.get(liveKey),c7_eps_uv:4100});
  assert.equal(verifyFixedTierBinding(applied,{...context,byKey:changedLinks}).reason,'fixed_tier_rule_or_evidence_changed_rebuild_required');checks++;
  const capped=applyFixedTierPrice({...row,platformMaximumActivityPrice:90},context);
  assert.equal(verifyFixedTierBinding({...row,platformMaximumActivityPrice:90},context).ok,true);
  assert.equal(capped.row.targetPrice,90);assert.equal(capped.row.intendedFinalTargetPrice,91.53);
  assert.equal(verifyFixedTierBinding(capped.row,context).ok,true);checks++;
  assert.equal(verifyFixedTierBinding({...capped.row,targetPrice:91.53},context).ok,false);checks++;
  const unproved={...row};delete unproved.reviewedWorkbookPrice;
  const noAuthority={...context,reviewedWorkbookPriceCapability:null};
  checkBlocked(unproved,noAuthority,'inherited_high_click_margin_below_floor');
  for(const [index,recomputed] of [[7,225.41],[8,97.27]]) {
    const legacy={...rows[index]};delete legacy.reviewedWorkbookPrice;
    assert.equal(resolveFixedTierPrice(legacy,noAuthority).price,recomputed);
    assert.equal(resolveFixedTierPrice(rows[index],context).price,rows[index].targetPrice);checks++;
  }
  const manifestOriginal=await fs.readFile(manifestPath,'utf8');
  const manifest=JSON.parse(manifestOriginal);
  await fs.writeFile(manifestPath,JSON.stringify({...manifest,reviewedWorkbook:{...manifest.reviewedWorkbook,businessDate:'2000-01-01'}}));
  await assert.rejects(loadOrdinaryCampaignApproval({root,manifestPath}),/current business date/);checks++;
  await fs.writeFile(manifestPath,manifestOriginal);
  await fs.writeFile(workbookPath,Buffer.from('changed workbook'));
  await assert.rejects(loadOrdinaryCampaignApproval({root,manifestPath}),/workbook changed/);checks++;
  await fs.writeFile(workbookPath,workbook);
  const lockedPricesPath=approval.pricesPath;
  const originalPrices=await fs.readFile(lockedPricesPath,'utf8');
  await fs.writeFile(lockedPricesPath,originalPrices.replace('91.53','91.54'));
  await assert.rejects(loadOrdinaryCampaignApproval({root,manifestPath}),/changed after authorization/);checks++;
  assert.equal(sha(await fs.readFile(workbookPath)),workbookSha256);
  console.log(JSON.stringify({ok:true,checks,offline:true,productionWrites:0,covered:['KF exact current price','three historical reconciliation products','SK1714-5 approved tiers','lock CLI and actual workbook hash','current scope and live evidence','platform cap and manual protection']}));
} finally {
  const relative=path.relative(tempRoot,dir);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  await fs.rm(dir,{recursive:true,force:true});
}
