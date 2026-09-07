#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {validateSavedQuery,initialPool,classifyEvidence,missingMetricReviewRows,sha,validDate} from '../lib/link_retire_review_evidence.mjs';
import {runLocalCloudTeamReport,buildCloudTeamReportBundle} from '../lib/cloud_team_report_local.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args={};
for(let i=2;i<process.argv.length;i++){
 const a=process.argv[i];
 if(a==='--send')args.send=true;
 else if(['--query','--run-date','--performance-date','--out-dir','--evidence','--supplement-evidence','--workbook','--cloud-ssh'].includes(a)) {
  const v=process.argv[++i];if(!v || v.startsWith('--'))throw new Error(`missing ${a}`);args[a.slice(2)]=v;
 }else throw new Error(`unknown ${a}`);
}
for(const k of ['query','run-date','performance-date','out-dir'])if(!args[k])throw new Error(`missing --${k}`);
const runDate=validDate(args['run-date']),performanceDate=validDate(args['performance-date']);
const cloudHost='shein-bi-tencent';
if(args['cloud-ssh'] && args['cloud-ssh']!==cloudHost)throw new Error('evidence and delivery host must be shein-bi-tencent');
const bytes=await fs.readFile(args.query),manifest=JSON.parse(await fs.readFile(`${args.query}.manifest.json`,'utf8'));
const query=validateSavedQuery(bytes,manifest),pool=initialPool(query,performanceDate),querySha256=sha(bytes);
const out=path.resolve(args['out-dir']);await fs.mkdir(out,{recursive:true});
const evidenceFile=path.join(out,'evidence.json'),analysisFile=path.join(out,'analysis.json');
const code=await fs.readFile(path.join(root,'scripts/collect_link_retire_review_evidence.mjs'));
const requestIdentity={runDate,performanceDate,querySha256,keys:pool.map(r=>({store_key:r.store_key,skc:r.skc}))};
const requestSha256=sha(JSON.stringify(requestIdentity));
async function readBoundEvidence(file) {
 const raw=await fs.readFile(file),binding=JSON.parse(await fs.readFile(`${file}.manifest.json`,'utf8'));
 const doc=JSON.parse(raw);
 if(binding.schemaVersion!=='link-retire-evidence-manifest/v1' || binding.host!==cloudHost || binding.collectorSha256!==sha(code) || binding.requestSha256!==requestSha256 || binding.evidenceSha256!==sha(raw) || binding.bytes!==raw.length || binding.sourcesSha256!==sha(JSON.stringify(doc.sources)))throw new Error('evidence provenance manifest mismatch');
 return raw;
}
let evidenceBytes;
if(args.evidence)evidenceBytes=await readBoundEvidence(args.evidence);
else {
 // No overwrite/recollection of an existing run. Resume with --evidence explicitly.
 try{await fs.access(evidenceFile);throw new Error('evidence exists: use --evidence to resume without collection');}catch(e){if(e.code!=='ENOENT')throw e;}
 const priorBytes=args['supplement-evidence']?await readBoundEvidence(args['supplement-evidence']):null;
 const priorEvidence=priorBytes?JSON.parse(priorBytes):undefined;
 const request=JSON.stringify({...requestIdentity,priorEvidence});
 const cmd=`cd /opt/shein-bi/app && node --input-type=module -e 'await import("data:text/javascript;base64,${code.toString('base64')}")'`;
 const result=spawnSync('ssh',['-o','BatchMode=yes',cloudHost,cmd],{input:request,encoding:'utf8',timeout:120000,maxBuffer:40*1024*1024});
 if(result.status!==0)throw new Error(`direct evidence collection failed: ${result.error?.code || String(result.stderr).slice(0,2000)}`);
 evidenceBytes=Buffer.from(result.stdout.trim());const doc=JSON.parse(evidenceBytes);await fs.writeFile(evidenceFile,evidenceBytes,{flag:'wx'});
 await fs.writeFile(`${evidenceFile}.manifest.json`,JSON.stringify({schemaVersion:'link-retire-evidence-manifest/v1',host:cloudHost,collectorSha256:sha(code),requestSha256,evidenceSha256:sha(evidenceBytes),bytes:evidenceBytes.length,sourcesSha256:sha(JSON.stringify(doc.sources)),priorEvidenceSha256:priorBytes?sha(priorBytes):null},null,2),{flag:'wx'});
}
const evidence=JSON.parse(evidenceBytes),evaluated=classifyEvidence(pool,evidence,{runDate,performanceDate,querySha256});
const missingMetricRows=missingMetricReviewRows(query);
evaluated.push(...missingMetricRows);
const counts={inputRows:query.data.storeLinks.length,basePool:pool.length,missingMetrics:missingMetricRows.length,reviewRows:evaluated.length,candidates:evaluated.filter(r=>r.retire_candidate_bucket==='candidate').length,pending:evaluated.filter(r=>r.retire_candidate_bucket==='cannotJudge').length,excluded:evaluated.filter(r=>r.retire_candidate_bucket==='excluded').length};
const evidenceSha256=sha(evidenceBytes),fingerprint=sha(JSON.stringify({runDate,performanceDate,querySha256,evidenceSha256}));
const summary={schemaVersion:'link-retire-review/v1',runDate,performanceDate,querySha256,evidenceSha256,fingerprint,counts,sourceQuery:path.resolve(args.query),sourceEvidence:args.evidence?path.resolve(args.evidence):evidenceFile,protectionReferenceDate:runDate,execution:'review only; no delisting authorization'};
await fs.writeFile(analysisFile,JSON.stringify({summary,evaluated},null,2));
const summaryFile=path.join(out,'summary.md');
await fs.writeFile(summaryFile,`# SHEIN弱链接审核 ${runDate}\n\n表现数据日：${performanceDate}。基础池 ${counts.basePool} 条，另有 ${counts.missingMetrics} 条缺表现指标，共审核 ${counts.reviewRows} 条；已放行候选 ${counts.candidates} 条；待确认 ${counts.pending} 条；排除 ${counts.excluded} 条。候选为0不代表不存在弱链接。\n\n缺失证据逐店SKC列入工作簿。保护期按审核日计算，工作簿仅供审核，未执行下架或改货号。\n\n证据指纹：${fingerprint}\n`);
let delivery=null;
if(args.send){
 if(!args.workbook)throw new Error('--send requires --workbook from this analysis');
 const workbook=path.resolve(args.workbook),receiptFile=path.join(out,'delivery-receipt.json');
 const wb=await fs.readFile(workbook);
 // Builder sidecar must bind the exact analysis and exact workbook bytes.
 const binding=JSON.parse(await fs.readFile(`${workbook}.manifest.json`,'utf8'));
 if(binding.analysisSha256!==sha(await fs.readFile(analysisFile)) || binding.workbookSha256!==sha(wb))throw new Error('workbook binding mismatch');
 const bundle=await buildCloudTeamReportBundle({automationId:'shein-3',businessDate:runDate,summaryFile,attachment:workbook,expectedAttachmentSha256:sha(wb),root});
 const claimCode=await fs.readFile(path.join(root,'lib/link_retire_review_delivery_guard.mjs'));
 const claimCommand=`const {claimRetireReviewDelivery}=await import("data:text/javascript;base64,${claimCode.toString('base64')}");console.log(JSON.stringify(await claimRetireReviewDelivery({root:"/srv/shein-bi/runtime/automation-delivery/shein-3",date:"${runDate}",fingerprint:"${bundle.fingerprint}"})));`;
 const claim=spawnSync('ssh',['-o','BatchMode=yes',cloudHost,`node --input-type=module -e 'await import("data:text/javascript;base64,${Buffer.from(claimCommand).toString('base64')}")'`],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 if(claim.status!==0)throw new Error('daily delivery claim unavailable or already used; inspect existing evidence, do not resend');
 const claimResult=JSON.parse(claim.stdout);
 if(!claimResult.claimed || claimResult.fingerprint!==bundle.fingerprint)throw new Error('daily delivery claim mismatch; do not resend');
 await fs.writeFile(path.join(out,'delivery-attempt.json'),JSON.stringify(claimResult,null,2),{flag:'wx'});
 delivery=await runLocalCloudTeamReport({automationId:'shein-3',businessDate:runDate,summaryFile,attachment:workbook,expectedAttachmentSha256:sha(wb),root,cloudSsh:args['cloud-ssh'] || 'shein-bi-tencent'});
 await fs.writeFile(receiptFile,JSON.stringify(delivery,null,2),{flag:'wx'});
 if(delivery.ok){
  const readbackCode=`import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
  const r=JSON.parse(fs.readFileSync(0,'utf8'));if(!/^[a-f0-9]{64}$/.test(r.fingerprint)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(r.date)||path.basename(r.name)!==r.name)throw new Error('invalid binding');
  const dir=path.join('/srv/shein-bi/runtime/automation-delivery/shein-3',r.date,r.fingerprint),s=JSON.parse(fs.readFileSync(path.join(dir,'state.json'))),b=fs.readFileSync(path.join(dir,r.name)),m=fs.readFileSync(path.join(dir,'summary.md'));
  const hash=x=>crypto.createHash('sha256').update(x).digest('hex');console.log(JSON.stringify({status:s.status,fingerprint:s.fingerprint,attachmentSha256:hash(b),attachmentBytes:b.length,summarySha256:hash(m),summaryAccepted:s.items?.summary?.accepted===true,attachmentAccepted:s.items?.attachment?.accepted===true,summaryMessageId:s.items?.summary?.messageId,attachmentMessageId:s.items?.attachment?.messageId}));`;
  const remote=spawnSync('ssh',['-o','BatchMode=yes','shein-bi-tencent',`sudo node --input-type=module -e 'await import("data:text/javascript;base64,${Buffer.from(readbackCode).toString('base64')}")'`],{input:JSON.stringify({fingerprint:delivery.fingerprint,date:runDate,name:path.basename(workbook)}),encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  if(remote.status!==0)throw new Error('delivery accepted; persistent readback unavailable, do not resend');
  const readback=JSON.parse(remote.stdout);
  readback.ok=readback.status==='ok' && readback.fingerprint===delivery.fingerprint && readback.attachmentSha256===sha(wb) && readback.attachmentBytes===wb.length && readback.summarySha256===sha(await fs.readFile(summaryFile)) && readback.summaryAccepted && readback.attachmentAccepted && readback.summaryMessageId===delivery.items.summary.messageId && readback.attachmentMessageId===delivery.items.attachment.messageId;
  await fs.writeFile(path.join(out,'delivery-readback.json'),JSON.stringify(readback,null,2),{flag:'wx'});
  if(!readback.ok)throw new Error('persistent delivery readback mismatch; do not resend');
 }
 if(!delivery.ok)process.exitCode=1;
}
console.log(JSON.stringify({ok:!args.send || delivery?.ok===true,analysisFile,summaryFile,evidenceFile,counts,fingerprint,delivery},null,2));
