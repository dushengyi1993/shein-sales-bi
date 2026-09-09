import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const source=fs.readFileSync(new URL('./cloud_link_business_sync.sh',import.meta.url),'utf8');
const block=source.split('validate_metric_refetch_paths_and_stores() {')[1].split("\nNODE\n}")[0].split("<<'NODE'\n")[1];assert(block);
const canonical=source.match(/^CANONICAL_METRIC_STORES="([^"]+)"/m)[1].split(' ');assert.equal(canonical.length,19);
const current=JSON.parse(fs.readFileSync(new URL('../config/stores.json',import.meta.url),'utf8')).stores;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'metric-refetch-scope-'));
try{
 fs.mkdirSync(path.join(dir,'config'));fs.mkdirSync(path.join(dir,'state','cloud_ops_alerts'),{recursive:true});
 const run=rows=>{fs.writeFileSync(path.join(dir,'config','stores.json'),JSON.stringify({stores:rows}));return spawnSync(process.execPath,['--input-type=commonjs','-e',block],{env:{...process.env,ROOT:dir,STATE_FILE:path.join(dir,'state','cloud_ops_alerts','fixture.json'),CANONICAL_STORES:canonical.join(' ')},encoding:'utf8',timeout:10000})};
 const active=current.filter(s=>s.enabled!==false);const bi=current.filter(s=>s.enabled===false&&s.biEnabled===true);assert(bi.length>=1);
 for(const rows of [active,current]){const r=run(rows);assert.equal(r.status,0,r.stderr)}
 for(const [label,rows] of [
 ['missing business store',current.filter(s=>s.storeKey!==canonical[0])],
 ['extra enabled store',[...current,{storeKey:'ZZ',enabled:true}]],
 ['unknown disabled extra',[...current,{storeKey:'ZZ',enabled:false}]],
 ['duplicate BI key',[...current,bi[0]]],
 ['duplicate business key',[...current,active[0]]],
 ['disabled canonical with BI flag',current.map(s=>s.storeKey===canonical[0]?{...s,enabled:false,biEnabled:true}:s)],
 ['nonboolean BI flag',[...active,{storeKey:'ZZ',enabled:false,biEnabled:'true'}]],
 ]){const r=run(rows);assert.notEqual(r.status,0,label+' must fail')}
 console.log(JSON.stringify({ok:true,test:'metric_refetch_store_scope',businessStores:active.length,biOnlyStores:bi.length,invalidCasesRejected:7}));
}finally{fs.rmSync(dir,{recursive:true,force:true})}
