import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {STORES,sha} from '../lib/link_retire_review_evidence.mjs';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'retire-review-entry-'));
try {
  const runDate='2026-09-07',performanceDate='2026-09-06';
  const query=Buffer.from(JSON.stringify({ok:true,aiInvoked:false,mode:'direct-bi-data',data:{dates:{linkDate:performanceDate},storeLinks:STORES.map(store_key=>({store_key,skc:'SKC1',is_on_shelf:true,c7_eps_uv:1000,c7_sale_cnt:1}))}}));
  const q=path.join(dir,'query.json'),e=path.join(dir,'evidence.json');
  await fs.writeFile(q,query);
  await fs.writeFile(`${q}.manifest.json`,JSON.stringify({run:{outcome:'succeeded',coverage:{issueCount:0,loadedSections:['linksData','productState']}},artifacts:[{role:'query_evidence',sha256:sha(query),bytes:query.length}]}));
  const raw=Buffer.from(JSON.stringify({schemaVersion:'link-retire-evidence/v1',host:'shein-bi-tencent',runDate,performanceDate,querySha256:sha(query),generatedAt:'2026-09-07T05:00:00Z',sources:[],rows:[]}));
  await fs.writeFile(e,raw);
  const manifest={schemaVersion:'link-retire-evidence-manifest/v1',host:'shein-bi-tencent',collectorSha256:sha(await fs.readFile('scripts/collect_link_retire_review_evidence.mjs')),requestSha256:sha(JSON.stringify({runDate,performanceDate,querySha256:sha(query),keys:[]})),evidenceSha256:sha(raw),bytes:raw.length,sourcesSha256:sha('[]')};
  const args=['scripts/link_retire_review.mjs','--query',q,'--run-date',runDate,'--performance-date',performanceDate,'--out-dir',path.join(dir,'out'),'--evidence',e];
  const run=extra=>spawnSync(process.execPath,[...args,...(extra || [])],{encoding:'utf8',timeout:10000});
  assert.notEqual(run().status,0,'missing sidecar must reject');
  for(const change of [{host:'other'},{collectorSha256:'0'.repeat(64)},{requestSha256:'0'.repeat(64)},{evidenceSha256:'0'.repeat(64)},{sourcesSha256:'0'.repeat(64)}]) {
    await fs.writeFile(`${e}.manifest.json`,JSON.stringify({...manifest,...change}));
    assert.notEqual(run().status,0,'tampered binding must reject');
  }
  await fs.writeFile(`${e}.manifest.json`,JSON.stringify(manifest));
  assert.notEqual(run(['--cloud-ssh','other']).status,0);
  const result=run();assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.reviewRows,0);
  console.log('PASS retire review entry: evidence provenance, host pin, offline bound resume');
} finally {await fs.rm(dir,{recursive:true,force:true});}
