#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {loadFixedTierStandard,fixedTierItem,resolveFixedTierPrice,verifyFixedTierBinding} from '../../lib/marketing_fixed_tier_pricing.mjs';
import {buildLowEtFastSellerPricingContext,applyLowEtFastSellerPricePullback} from '../../lib/marketing_low_et_fast_seller_pricing.mjs';
import {buildHighClickLowConversionSpecialAudit} from '../../lib/marketing_high_click_special_policy.mjs';
import {buildLinkRowIndexFromBi} from '../../lib/marketing_pricing_policy.mjs';
import {collectLatestRawMarketingLinkRows,assessLatestRawMarketingLinkCoverage,mergeMarketingLinkRows} from '../../lib/marketing_latest_raw_link_overlay.mjs';
import {buildLimitedDiscountDriftRescuePlan} from './build_limited_discount_drift_rescue_plan.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2);
if (args.length!==4 || args[0]!=='--date' || args[2]!=='--out') throw Error('Usage: --date YYYY-MM-DD --out exclusive-result.json');
const date=args[1],out=path.resolve(args[3]);
const read=async p=>JSON.parse(await fs.readFile(path.resolve(root,p),'utf8'));
const [links,inventory,policy,stores]=await Promise.all(['outputs/bi-portal/sections/linksData.json','outputs/bi-portal/sections/inventoryTrend.json','config/marketing_pricing_policy.json','config/stores.json'].map(read));
const storeKeys=stores.stores.filter(s=>s.enabled!==false).map(s=>s.storeKey);
const historyDir=path.join(root,'outputs/shein_links');
const raw=collectLatestRawMarketingLinkRows({historyDir,reportDate:date,storeKeys});
const coverage=assessLatestRawMarketingLinkCoverage({sourceFiles:raw.sourceFiles,errors:raw.errors,storeKeys});
if (!coverage.complete) throw Error(`Incomplete raw-link coverage:${JSON.stringify(coverage)}`);
const storeLinks=mergeMarketingLinkRows([...buildLinkRowIndexFromBi(links).byLinkKey.values()],raw.rows).rows;
const context=buildLowEtFastSellerPricingContext({linksDataDoc:{storeLinks},inventoryTrendDoc:inventory,baselineDoc:{items:[]},marketingPolicy:policy,reportDate:date});
const rows=[];
for (const link of storeLinks) {
  const canonical=link.standard_goods_sn || link.standardGoodsSn || link.canonical;
  if (!fixedTierItem(canonical)) continue;
  const row={...link,canonical,storeKey:link.storeKey || link.store_key,skc:link.skc};
  const fixed=resolveFixedTierPrice(row,context.fixedTierContext);
  const execution=applyLowEtFastSellerPricePullback({row,context});
  if (!fixed.blocked && execution.row.finalTargetPrice!==fixed.price) throw Error('entrypoint_fixed_price_mismatch');
  rows.push({storeKey:row.storeKey,skc:row.skc,canonical,blocked:fixed.blocked,reason:fixed.reason || 'fixed_tier_exact',price:fixed.price ?? null,binding:fixed.binding || null,ordinaryAndFallback:execution.audit?.mode || execution.reason,executionBinding:fixed.blocked ? null : verifyFixedTierBinding(execution.row,context.fixedTierContext)});
}
const high=buildHighClickLowConversionSpecialAudit({linksDataDoc:{storeLinks},inventoryTrendDoc:inventory,priceOverridesDoc:{items:[]},costDoc:{},manualRegistry:{entries:[]},marketingPolicy:policy,reportDate:date});
const highRows=[...high.rows,...high.pendingApprovalRows].filter(r=>fixedTierItem(r.canonical));
for(const r of highRows) if (r.specialPrice!==r.fixedTierPricing?.price) throw Error('high_click_fixed_price_mismatch');
// Existing guard provides observed below-target candidates; no synthetic activity or submission is created.
const guard=await read(`outputs/reports/marketing-daily-guard-${date}.json`);
const drift=buildLimitedDiscountDriftRescuePlan(guard,{lowEtContext:context,costDoc:{}});
const standard=loadFixedTierStandard();
const result={schemaVersion:'marketing-fixed-tier-runtime-evidence/v1',readOnly:true,productionWrites:0,platformSubmissionAttempted:false,asOf:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),ruleVersion:standard.doc.version,ruleHash:standard.sha256,coverage,linksGeneratedAt:links.generatedAt,entrypoints:{ordinaryAndFallback:'applyLowEtFastSellerPricePullback',highClick:'buildHighClickLowConversionSpecialAudit',driftRepair:'buildLimitedDiscountDriftRescuePlan'},rows,highClickRows:highRows,driftSummary:drift.totals};
await fs.mkdir(path.dirname(out),{recursive:true});await fs.writeFile(out,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({ok:true,out,ruleVersion:result.ruleVersion,ruleHash:result.ruleHash,rows:rows.length,exact:rows.filter(r=>!r.blocked).length,blocked:rows.filter(r=>r.blocked).length,highClick:highRows.length,productionWrites:0},null,2));
