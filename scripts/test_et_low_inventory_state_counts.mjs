import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const source=fs.readFileSync(new URL('./cloud_et_low_inventory_guard.sh',import.meta.url),'utf8');
const body=source.match(/^persist_completed_state\(\) \{\r?\n[\s\S]*?^\}/m)?.[0];
assert(body);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'et-state-counts-'));
const kernel=spawnSync('bash',['-lc','uname -s'],{encoding:'utf8'}).stdout.trim();
const mapped=p=>process.platform!=='win32'?p:path.resolve(p).replace(/^([A-Za-z]):/,(_,d)=>kernel==='Linux'?'/mnt/'+d.toLowerCase():'/'+d.toLowerCase()).replaceAll('\\','/');
try {
  const script=path.join(root,'fixture.sh'),plan=path.join(root,'plan.json'),result=path.join(root,'result.json'),state=path.join(root,'state.json');
  fs.writeFileSync(script,`set -Eeuo pipefail\nPLAN="$1"\nSTATE="$3"\nTOTAL=0\nHASH=fixture\nBATCH_ID=fixture\nET_MANIFEST_HASH=fixture\n${body}\npersist_completed_state "$2"\n`);
  const cases=[
    {name:'blocked is not submitted',watch:{blockedLowEtCanonicalCount:16,active:true},rows:[],ok:false,pending:0,unknown:0,blocked:16},
    {name:'unknown ET remains unknown',watch:{unknownEtCanonicalCount:13},rows:[],ok:false,pending:0,unknown:13,blocked:0},
    {name:'pending canonical deduplicates links',watch:{},rows:[{state:'submitted_but_readback_pending',matchKey:'one'},{state:'submitted_but_readback_pending',matchKey:'one'},{state:'submitted_but_readback_pending',matchKey:'two'}],ok:false,pending:2,unknown:0,blocked:0},
    {name:'healthy low stock watch',watch:{active:true},rows:[],ok:true,pending:0,unknown:0,blocked:0},
  ];
  for(const c of cases){
    fs.writeFileSync(plan,JSON.stringify({watch:c.watch}));fs.writeFileSync(result,JSON.stringify({results:c.rows}));
    const run=spawnSync('bash',[mapped(script),mapped(plan),mapped(result),mapped(state)],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);const actual=JSON.parse(fs.readFileSync(state,'utf8'));
    assert.equal(actual.ok,c.ok,c.name);assert.equal(actual.counts.pendingCanonical,c.pending,c.name);
    assert.equal(actual.counts.unknownEtCanonical,c.unknown,c.name);assert.equal(actual.counts.blockedCanonical,c.blocked,c.name);
    assert.equal(actual.businessState,'watching',c.name);
  }
  console.log(JSON.stringify({ok:true,cases:cases.length,realBashStateFunction:true}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
