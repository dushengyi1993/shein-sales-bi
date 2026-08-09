#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function run(args, env) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/marketing/replace_limited_discount_transactionally.mjs', ...args], {
      cwd: ROOT,
      env: {...process.env, ...env},
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try { return JSON.parse(source.slice(start)); } catch {}
  }
  throw new Error(`No trailing JSON object found in: ${source.slice(-1000)}`);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'limited-discount-transaction-smoke-'));
try {
  const statePath = path.join(temp, 'state.json');
  const eventPath = path.join(temp, 'events.ndjson');
  const fakeApply = path.join(temp, 'fake-apply.mjs');
  const fakeRemove = path.join(temp, 'fake-remove.mjs');
  const rescuePath = path.join(temp, 'rescue.json');
  const rescue = {
    storeKey: 'DL',
    purpose: 'smoke_transactional_replacement',
    sourceLimitedDiscountName: '旧限时折扣',
    activityNamePrefix: '目标限时折扣',
    endTime: '2099-12-31 23:59:59',
    activityStock: 10,
    rows: [{
      storeKey: 'DL',
      skc: 'SMOKE-SKC-1',
      limitedDiscountPrice: 80,
      finalTargetPrice: 80,
      needsLimitedDiscount: true,
    }],
  };
  await fs.writeFile(rescuePath, JSON.stringify(rescue), 'utf8');
  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, restored: false, allowDesired: false, desiredCovered: false}), 'utf8');

  await fs.writeFile(fakeApply, `
import fs from 'node:fs/promises';
import path from 'node:path';
const argv=process.argv.slice(2);
const value=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:''};
const execute=argv.includes('--execute');
const rescuePath=value('--rescue');
const rescue=JSON.parse(await fs.readFile(rescuePath,'utf8'));
const state=JSON.parse(await fs.readFile(process.env.SMOKE_STATE,'utf8'));
const compensation=String(rescue.purpose||'').includes('compensation_restore');
const row=rescue.rows[0];
await fs.appendFile(process.env.SMOKE_EVENTS,JSON.stringify({tool:'apply',execute,compensation,skc:row.skc})+'\\n');
let full;
if(state.desiredCovered){
  full={ok:true,alreadyCovered:true,before:{conflictActivities:[{activity_id:333,act_name:'目标限时折扣',state:3,start_time:'2026-01-01 00:00:00',end_time:'2099-12-31 23:59:59',targetSkcs:[row.skc],extraSkcs:[],targetGoods:[{skc:row.skc,product_act_price:row.limitedDiscountPrice,attend_num_sum:10,stock_num:10}]}]},validation:{missing:[],invalid:[{skc:row.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0006'}]},after:null};
}else if(state.oldCovered){
  full={ok:false,reason:'unsafe mixed activity',before:{conflictActivities:[{activity_id:111,act_name:'旧混合限时折扣',state:3,start_time:'2026-01-01 00:00:00',end_time:'2099-12-31 23:59:59',targetSkcs:[row.skc],extraSkcs:['EXTRA-SKC'],targetGoods:[{skc:row.skc,product_act_price:70,attend_num_sum:10,stock_num:10}]}]},validation:{missing:[],invalid:[{skc:row.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0004'}]},after:null};
}else if(!compensation&&!state.allowDesired){
  full={ok:false,reason:'platform blocked',before:{conflictActivities:[]},validation:{missing:[],invalid:[{skc:row.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0004'}]},after:null};
}else if(!compensation&&!execute){
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else if(!compensation){
  state.desiredCovered=true;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
  full={ok:true,createdActivityId:333,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:[{skc:row.skc,ok:true}],conflictActivities:[]}};
}else if(!execute){
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else{
  state.oldCovered=true;state.restored=true;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
  full={ok:true,createdActivityId:222,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:[{skc:row.skc,ok:true}],conflictActivities:[]}};
}
const out=path.join(process.env.SMOKE_DIR,'apply-'+Date.now()+'-'+Math.random()+'.json');
await fs.writeFile(out,JSON.stringify(full));
console.log(JSON.stringify({ok:full.ok,out}));
if(!full.ok)process.exitCode=2;
`, 'utf8');

  await fs.writeFile(fakeRemove, `
import fs from 'node:fs/promises';
import path from 'node:path';
const argv=process.argv.slice(2);
const execute=argv.includes('--execute');
const state=JSON.parse(await fs.readFile(process.env.SMOKE_STATE,'utf8'));
await fs.appendFile(process.env.SMOKE_EVENTS,JSON.stringify({tool:'remove',execute})+'\\n');
const before={totalSkcs:2,skcs:['SMOKE-SKC-1','EXTRA-SKC'],removeSkcsPresent:['SMOKE-SKC-1'],missingToRemove:[],preserveSkcs:['EXTRA-SKC'],goods:[{skc:'SMOKE-SKC-1',sku_supplier_no:'SMOKE',product_act_price:70,attend_num_sum:10,stock_num:10},{skc:'EXTRA-SKC',sku_supplier_no:'EXTRA',product_act_price:75,attend_num_sum:10,stock_num:10}]};
let after=null;
if(execute){state.oldCovered=false;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));after={totalSkcs:1,skcs:['EXTRA-SKC'],stillPresent:[],missingPreserved:[],unexpectedAdded:[],goods:[before.goods[1]]};}
const full={ok:true,results:[{ok:true,before,after,dryRunOnly:!execute}]};
const out=path.join(process.env.SMOKE_DIR,'remove-'+Date.now()+'-'+Math.random()+'.json');
await fs.writeFile(out,JSON.stringify(full));
console.log(JSON.stringify({ok:true,out}));
`, 'utf8');

  const env = {
    SHEIN_MARKETING_APPLY_SCRIPT: fakeApply,
    SHEIN_MARKETING_REMOVE_SCRIPT: fakeRemove,
    SHEIN_BI_MARKETING_AUTOMATION_CONTEXT: 'cloud_timer',
    SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION: 'owner-standing-cloud-marketing-v1',
    SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH: 'a'.repeat(64),
    SMOKE_STATE: statePath,
    SMOKE_EVENTS: eventPath,
    SMOKE_DIR: temp,
  };
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescuePath)).digest('hex');

  const dryDir = path.join(temp, 'dry');
  const dry = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--dry-run',
    '--out-dir', dryDir, '--journal-dir', path.join(dryDir, 'journals'),
  ], env);
  assert.equal(dry.code, 0, dry.stderr || dry.stdout);
  let events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, 'dry-run must never call a destructive remove');

  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, restored: false, allowDesired: false, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const executeDir = path.join(temp, 'execute');
  const executed = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--out-dir', executeDir, '--journal-dir', path.join(executeDir, 'journals'),
  ], env);
  assert.equal(executed.code, 2, executed.stderr || executed.stdout);
  const summary = parseLastJson(executed.stdout);
  assert.equal(summary.safe, true);
  assert.equal(summary.status, 'platform_blocked_old_protection_restored');
  assert.deepEqual(summary.uncoveredSkcs, []);
  const finalState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(finalState.oldCovered, true);
  assert.equal(finalState.restored, true);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const destructiveIndex = events.findIndex(event => event.tool === 'remove' && event.execute);
  const snapshotIndex = events.findIndex(event => event.tool === 'remove' && !event.execute);
  const restoreIndex = events.findIndex(event => event.tool === 'apply' && event.execute && event.compensation);
  assert(snapshotIndex >= 0 && snapshotIndex < destructiveIndex, 'snapshot must be locked before deletion');
  assert(restoreIndex > destructiveIndex, 'compensation must run after failed post-delete validation');
  assert.equal(events.filter(event => event.tool === 'remove' && event.execute).length, 1, 'mixed activity replacement removes only the target SKC once');

  await fs.writeFile(statePath, JSON.stringify({...finalState, allowDesired: true, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const retried = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--out-dir', executeDir, '--journal-dir', path.join(executeDir, 'journals'),
  ], env);
  assert.equal(retried.code, 0, retried.stderr || retried.stdout);
  const retriedSummary = parseLastJson(retried.stdout);
  assert.equal(retriedSummary.status, 'replaced_all');
  assert.deepEqual(retriedSummary.desiredCoveredSkcs, ['SMOKE-SKC-1']);
  const journal = JSON.parse(await fs.readFile(path.resolve(ROOT, retriedSummary.journalPath), 'utf8').catch(async () => {
    const files = await fs.readdir(path.join(executeDir, 'journals'));
    return await fs.readFile(path.join(executeDir, 'journals', files[0]), 'utf8');
  }));
  assert.equal(journal.attempt, 2);
  assert.equal(journal.attemptHistory.length, 1);

  console.log(JSON.stringify({
    ok: true,
    test: 'mixed_0004_limited_discount_replacement_snapshots_target_only_compensates_and_retries',
  }));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
