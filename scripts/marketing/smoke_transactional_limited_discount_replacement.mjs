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
  const multiRescuePath = path.join(temp, 'multi-rescue.json');
  await fs.writeFile(multiRescuePath, JSON.stringify({
    ...rescue,
    rows: [rescue.rows[0], {...rescue.rows[0], skc: 'SMOKE-SKC-2', limitedDiscountPrice: 81, finalTargetPrice: 81}],
  }), 'utf8');
  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, oldConflictCode: '0006', restored: false, allowDesired: false, desiredCovered: false}), 'utf8');

  await fs.writeFile(fakeApply, `
import fs from 'node:fs/promises';
import path from 'node:path';
const argv=process.argv.slice(2);
const value=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:''};
const execute=argv.includes('--execute');
const rescuePath=value('--rescue');
const rescue=JSON.parse(await fs.readFile(rescuePath,'utf8'));
const state=JSON.parse(await fs.readFile(process.env.SMOKE_STATE,'utf8'));
state.applyCallCount=Number(state.applyCallCount||0)+1;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
const compensation=String(rescue.purpose||'').includes('compensation_restore');
const rows=rescue.rows;
const row=rescue.rows[0];
const conflictCodeFor=current=>state.invalidCodes?.[current.skc]||state.oldConflictCode||'0006';
const platformCode=current=>\`mrs-simple_platform_limit_discounts-\${conflictCodeFor(current)}\`;
const oldPrice=current=>state.exactOld===true?current.limitedDiscountPrice:Number(state.oldPrices?.[current.skc]??70);
const oldActivityStock=Number(state.oldActivityStock??7);
const oldEndTime=state.driftActivityEndOnSecondApply&&state.applyCallCount===2?'2097-01-01 00:00:00':state.oldEndTime||'2098-06-30 23:59:59';
await fs.appendFile(process.env.SMOKE_EVENTS,JSON.stringify({tool:'apply',execute,compensation,skc:row.skc,price:row.limitedDiscountPrice,activityStock:row.activityStock??rescue.activityStock,endTime:rescue.endTime})+'\\n');
if(state.nullSubsetPreflight&&rescuePath.includes('post-delete-executable-subset')){console.log(JSON.stringify({ok:true}));process.exit(0);}
let full;
if(state.desiredCovered){
  full={ok:true,alreadyCovered:true,before:{conflictActivities:[{activity_id:333,act_name:'目标限时折扣',state:3,start_time:'2026-01-01 00:00:00',end_time:'2099-12-31 23:59:59',targetSkcs:rows.map(current=>current.skc),extraSkcs:[],targetGoods:rows.map(current=>({skc:current.skc,product_act_price:current.limitedDiscountPrice,attend_num_sum:10,stock_num:10}))}]},validation:{missing:[],invalid:rows.map(current=>({skc:current.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0006'}))},after:null};
}else if(state.oldCovered){
  const invalid=state.omitInvalid===true?[]:rows.map(current=>({skc:current.skc,reason:'query_goods error_code',error_code:platformCode(current)}));
  invalid.push(...(state.additionalInvalidRows||[]));
  full={ok:false,reason:'unsafe mixed activity',before:{conflictActivities:[{activity_id:111,act_name:'旧混合限时折扣',state:3,start_time:'2026-01-01 00:00:00',end_time:oldEndTime,targetSkcs:rows.map(current=>current.skc),extraSkcs:state.extraSkcs||['EXTRA-SKC'],targetGoods:rows.map(current=>({skc:current.skc,product_act_price:oldPrice(current),attend_num_sum:oldActivityStock,stock_num:10}))}]},validation:{missing:[],invalid},after:null};
}else if(!compensation&&!state.allowDesired){
  full={ok:false,reason:'platform blocked',before:{conflictActivities:[]},validation:{missing:[],invalid:rows.map(current=>({skc:current.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0004'}))},after:null};
}else if(compensation&&!state.allowCompensation){
  full={ok:false,reason:'compensation platform blocked',before:{conflictActivities:[]},validation:{missing:[],invalid:rows.map(current=>({skc:current.skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0004'}))},after:null};
}else if(!compensation&&!execute&&state.postDeleteBlockFirst){
  full={ok:false,reason:'partial platform block',targetSkcs:rows.map(current=>current.skc),before:{conflictActivities:[]},validation:{missing:[],invalid:[{skc:rows[0].skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0004'}]},after:null};
}else if(!compensation&&!execute){
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else if(!compensation&&execute&&state.failDesired){
  full={ok:false,writeAttempted:true,status:'submitted_without_exact_readback',reason:'simulated create result unknown',before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else if(!compensation){
  state.desiredCovered=true;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
  full={ok:true,createdActivityId:333,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:rows.map(current=>({skc:current.skc,ok:true})),conflictActivities:[]}};
}else if(!execute){
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else{
  state.oldCovered=true;state.restored=true;await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
  full={ok:true,createdActivityId:222,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:rows.map(current=>({skc:current.skc,ok:true})),conflictActivities:[]}};
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
const value=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:''};
const execute=argv.includes('--execute');
const state=JSON.parse(await fs.readFile(process.env.SMOKE_STATE,'utf8'));
const requested=value('--skcs').split(',').map(value=>value.trim()).filter(Boolean);
state.removeCallCount=Number(state.removeCallCount||0)+1;
const configuredExtraSkcs=state.extraSkcs||['EXTRA-SKC'];
const extraSkcs=!execute&&state.driftOnSecondRemoveDryRun&&state.removeCallCount===2?configuredExtraSkcs.slice(1):configuredExtraSkcs;
await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
const oldActivityStock=Number(state.oldActivityStock??7);
const driftTargetAttributes=!execute&&state.driftTargetStockOnSecondRemoveDryRun&&state.removeCallCount===2;
const targetGoods=requested.map((skc,index)=>({skc,sku_supplier_no:'SMOKE-'+index,product_act_price:Number(state.oldPrices?.[skc]??70+index),attend_num_sum:oldActivityStock,stock_num:10-(driftTargetAttributes&&index===0?1:0)}));
const driftBeforeAttributes=!execute&&state.driftPriceOnSecondRemoveDryRun&&state.removeCallCount===2;
const extraGoods=extraSkcs.map((skc,index)=>({skc,sku_supplier_no:'EXTRA-'+index,product_act_price:75+index+(driftBeforeAttributes&&index===0?1:0),attend_num_sum:10,stock_num:10}));
const beforeSkcs=[...requested,...extraSkcs].sort();
const before={totalSkcs:beforeSkcs.length,skcs:beforeSkcs,removeSkcsPresent:[...requested].sort(),missingToRemove:[],preserveSkcs:[...extraSkcs].sort(),goods:[...targetGoods,...extraGoods]};
let after=null;
if(execute){
  state.oldCovered=false;
  await fs.writeFile(process.env.SMOKE_STATE,JSON.stringify(state));
  const afterSkcs=state.dropPreservedOnDelete?[...extraSkcs].slice(1):[...extraSkcs];
  const missingPreserved=extraSkcs.filter(skc=>!afterSkcs.includes(skc));
  const afterGoods=extraGoods.filter(good=>afterSkcs.includes(good.skc)).map((good,index)=>state.mutatePreservedAfterDelete&&index===0?{...good,stock_num:good.stock_num-1}:good);
  const contractValidation=state.mutateActivityAfterDelete
    ? {ok:false,errors:['after_activity_end_time_changed'],changedSkcs:[]}
    : {ok:true,errors:[],changedSkcs:[]};
  after={totalSkcs:afterSkcs.length,skcs:[...afterSkcs].sort(),stillPresent:[],missingPreserved,unexpectedAdded:[],goods:afterGoods,contractValidation};
}
await fs.appendFile(process.env.SMOKE_EVENTS,JSON.stringify({tool:'remove',execute,requested,preserveSkcs:before.preserveSkcs,afterSkcs:after?.skcs||[],missingPreserved:after?.missingPreserved||[]})+'\\n');
const full={ok:true,results:[{ok:true,before,after,dryRunOnly:!execute}]};
if(execute&&(after.missingPreserved.length||after.contractValidation.ok===false)){full.ok=false;full.results[0].ok=false;}
const out=path.join(process.env.SMOKE_DIR,'remove-'+Date.now()+'-'+Math.random()+'.json');
await fs.writeFile(out,JSON.stringify(full));
console.log(JSON.stringify({ok:full.ok,out}));
if(!full.ok)process.exitCode=2;
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
  const multiRescueHash = crypto.createHash('sha256').update(await fs.readFile(multiRescuePath)).digest('hex');

  const cloudGateOnly = process.platform !== 'win32'
    && await pathExists('/srv/shein-bi')
    && await pathExists('/run/lock/shein-host-heavy.lock')
    && process.env.SHEIN_BI_HOST_HEAVY_DOMAIN !== 'marketing-repair';
  if (cloudGateOnly) {
    const gateDir = path.join(temp, 'cloud-gate');
    const gateProbe = await run([
      '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
      '--expected-rescue-hash', rescueHash, '--execute',
      '--transaction-id', 'smoke-cloud-write-gate-fail-closed',
      '--out-dir', gateDir, '--journal-dir', path.join(gateDir, 'journals'),
    ], env);
    assert.equal(gateProbe.code, 4, gateProbe.stderr || gateProbe.stdout);
    assert.match(gateProbe.stderr, /cloud_marketing_write_requires_(shared_host_wrapper|marketing_repair_domain)/);
    const cloudEvents = (await fs.readFile(eventPath, 'utf8').catch(() => '')).trim();
    assert.equal(cloudEvents, '', 'cloud gate rejection must occur before either fake adapter executes');
    console.log(JSON.stringify({ok: true, test: 'cloud_marketing_write_gate_fail_closed'}));
  } else {
  const dryDir = path.join(temp, 'dry');
  const dry = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--dry-run',
    '--out-dir', dryDir, '--journal-dir', path.join(dryDir, 'journals'),
  ], env);
  assert.equal(dry.code, 0, dry.stderr || dry.stdout);
  let events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, 'dry-run must never call a destructive remove');

  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, oldConflictCode: '0004', restored: false, allowDesired: false, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const blocked0004Dir = path.join(temp, 'blocked-0004');
  const blocked0004 = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-0004-without-conflict-evidence',
    '--out-dir', blocked0004Dir, '--journal-dir', path.join(blocked0004Dir, 'journals'),
  ], env);
  assert.equal(blocked0004.code, 2, blocked0004.stderr || blocked0004.stdout);
  const blocked0004Summary = parseLastJson(blocked0004.stdout);
  assert.equal(blocked0004Summary.safe, true);
  assert.equal(blocked0004Summary.status, 'initial_platform_blocked_preserved');
  assert.deepEqual(blocked0004Summary.initiallyBlockedSkcs, ['SMOKE-SKC-1']);
  const blocked0004State = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(blocked0004State.oldCovered, true);
  assert.equal(blocked0004State.restored, false);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, '0004 must stop before delete even with exact active conflict evidence');

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0004',
    additionalInvalidRows: [{
      skc: 'SMOKE-SKC-1',
      reason: 'query_goods error_code',
      error_code: 'mrs-simple_platform_limit_discounts-101018',
    }],
    restored: false,
    allowDesired: false,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const mixedBlockedDir = path.join(temp, 'mixed-blocked-0004-101018');
  const mixedBlocked = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-mixed-0004-101018-atomic-guard',
    '--out-dir', mixedBlockedDir, '--journal-dir', path.join(mixedBlockedDir, 'journals'),
  ], env);
  assert.equal(mixedBlocked.code, 2, mixedBlocked.stderr || mixedBlocked.stdout);
  const mixedBlockedSummary = parseLastJson(mixedBlocked.stdout);
  assert.equal(mixedBlockedSummary.status, 'initial_platform_blocked_preserved');
  assert.deepEqual(mixedBlockedSummary.initiallyBlockedSkcs, ['SMOKE-SKC-1']);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, '0004 must not swallow a same-SKC 101018 blocker');

  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, omitInvalid: true, restored: false, allowDesired: false, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const missing0006Dir = path.join(temp, 'conflict-without-0006');
  const missing0006 = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-conflict-without-explicit-0006',
    '--out-dir', missing0006Dir, '--journal-dir', path.join(missing0006Dir, 'journals'),
  ], env);
  assert.equal(missing0006.code, 2, missing0006.stderr || missing0006.stdout);
  const missing0006Summary = parseLastJson(missing0006.stdout);
  assert.equal(missing0006Summary.status, 'initial_platform_blocked_preserved');
  assert.deepEqual(missing0006Summary.initiallyBlockedSkcs, ['SMOKE-SKC-1']);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, 'conflict without an exact managed query_goods code must stop before delete');

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['DRIFTED-A', 'DRIFTED-B'],
    driftOnSecondRemoveDryRun: true,
    restored: false,
    allowDesired: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const driftDir = path.join(temp, 'pre-delete-membership-drift');
  const drift = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-pre-delete-membership-drift',
    '--out-dir', driftDir, '--journal-dir', path.join(driftDir, 'journals'),
  ], env);
  assert.equal(drift.code, 2, drift.stderr || drift.stdout);
  const driftSummary = parseLastJson(drift.stdout);
  assert.equal(driftSummary.status, 'pre_delete_membership_drift_old_protection_preserved');
  assert.equal(driftSummary.writeAttempted, false);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.tool === 'remove' && event.execute), false, 'membership drift must stop before the first delete write');

  for (const propertyDrift of [
    {name: 'activity-end', state: {driftActivityEndOnSecondApply: true}, status: 'pre_delete_activity_drift_old_protection_preserved'},
    {name: 'preserved-goods-price', state: {driftPriceOnSecondRemoveDryRun: true}, status: 'pre_delete_membership_drift_old_protection_preserved'},
    {name: 'target-goods-stock', state: {driftTargetStockOnSecondRemoveDryRun: true}, status: 'pre_delete_membership_drift_old_protection_preserved'},
  ]) {
    await fs.writeFile(statePath, JSON.stringify({
      oldCovered: true,
      oldConflictCode: '0006',
      extraSkcs: ['ATTRIBUTE-EXTRA'],
      allowDesired: true,
      desiredCovered: false,
      ...propertyDrift.state,
    }), 'utf8');
    await fs.writeFile(eventPath, '', 'utf8');
    const propertyDir = path.join(temp, `pre-delete-${propertyDrift.name}-drift`);
    const propertyResult = await run([
      '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
      '--expected-rescue-hash', rescueHash, '--execute',
      '--transaction-id', `smoke-pre-delete-${propertyDrift.name}-drift`,
      '--out-dir', propertyDir, '--journal-dir', path.join(propertyDir, 'journals'),
    ], env);
    assert.equal(propertyResult.code, 2, propertyResult.stderr || propertyResult.stdout);
    assert.equal(parseLastJson(propertyResult.stdout).status, propertyDrift.status);
    events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(events.some(event => event.tool === 'remove' && event.execute), false,
      `${propertyDrift.name} drift must stop before delete`);
  }

  const sixteenExtras = Array.from({length: 16}, (_, index) => `EXTRA-SKC-${index + 1}`);
  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, oldConflictCode: '0006', extraSkcs: sixteenExtras, oldActivityStock: 7, oldEndTime: '2098-06-30 23:59:59', restored: false, allowDesired: false, allowCompensation: false, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const executeDir = path.join(temp, 'execute');
  const executed = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--out-dir', executeDir, '--journal-dir', path.join(executeDir, 'journals'),
  ], env);
  assert.equal(executed.code, 4, executed.stderr || executed.stdout);
  const summary = parseLastJson(executed.stdout);
  assert.equal(summary.safe, false);
  assert.equal(summary.status, 'unsafe_uncovered');
  assert.deepEqual(summary.uncoveredSkcs, ['SMOKE-SKC-1']);
  const finalState = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(finalState.oldCovered, false);
  assert.equal(finalState.restored, false);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const destructiveIndex = events.findIndex(event => event.tool === 'remove' && event.execute);
  const snapshotIndex = events.findIndex(event => event.tool === 'remove' && !event.execute);
  const restoreIndex = events.findIndex(event => event.tool === 'apply' && event.execute && event.compensation);
  assert(snapshotIndex >= 0 && snapshotIndex < destructiveIndex, 'snapshot must be locked before deletion');
  assert.equal(restoreIndex, -1, 'persistent 0004 must block compensation create instead of assuming restoration capability');
  assert.equal(events.filter(event => event.tool === 'remove' && event.execute).length, 1, 'mixed activity replacement removes only the target SKC once');
  const selectiveDelete = events.find(event => event.tool === 'remove' && event.execute);
  assert.deepEqual(selectiveDelete.preserveSkcs, [...sixteenExtras].sort(), 'all mixed-activity non-target members must be locked before delete');
  assert.deepEqual(selectiveDelete.afterSkcs, [...sixteenExtras].sort(), 'all mixed-activity non-target members must survive delete readback');

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['NULL-SUBSET-EXTRA'],
    allowDesired: true,
    allowCompensation: true,
    postDeleteBlockFirst: true,
    nullSubsetPreflight: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const nullSubsetDir = path.join(temp, 'null-subset-after-delete');
  const nullSubset = await run([
    '--store', 'DL', '--port', '9999', '--rescue', multiRescuePath,
    '--expected-rescue-hash', multiRescueHash, '--execute',
    '--transaction-id', 'smoke-null-subset-after-delete',
    '--out-dir', nullSubsetDir, '--journal-dir', path.join(nullSubsetDir, 'journals'),
  ], env);
  assert.equal(nullSubset.code, 2, nullSubset.stderr || nullSubset.stdout);
  const nullSubsetSummary = parseLastJson(nullSubset.stdout);
  assert.equal(nullSubsetSummary.status, 'platform_blocked_old_protection_restored');
  assert.equal(nullSubsetSummary.safe, true);
  assert.deepEqual(nullSubsetSummary.postDeleteBlockedSkcs, ['SMOKE-SKC-1']);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(event => event.tool === 'apply' && event.execute && event.compensation).length, 1,
    'a null subset preflight after deletion must still enter compensation instead of escaping through TypeError');

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['PENDING-EXTRA'],
    allowDesired: true,
    allowCompensation: true,
    failDesired: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const pendingDir = path.join(temp, 'desired-create-pending');
  const pendingArgs = [
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-desired-create-pending',
    '--out-dir', pendingDir, '--journal-dir', path.join(pendingDir, 'journals'),
  ];
  const pending = await run(pendingArgs, env);
  assert.equal(pending.code, 4, pending.stderr || pending.stdout);
  const pendingSummary = parseLastJson(pending.stdout);
  assert.equal(pendingSummary.classification, 'submitted_without_exact_readback');
  assert.equal(pendingSummary.safe, false);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(event => event.tool === 'apply' && event.execute && !event.compensation).length, 1);
  assert.equal(events.filter(event => event.tool === 'apply' && event.execute && event.compensation).length, 0,
    'unknown desired create must never trigger a compensation create');
  const pendingEventCount = events.length;
  const pendingAgain = await run(pendingArgs, env);
  assert.equal(pendingAgain.code, 4, pendingAgain.stderr || pendingAgain.stdout);
  assert.equal(parseLastJson(pendingAgain.stdout).resumedFromTerminalJournal, true);
  events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.length, pendingEventCount, 'terminal pending create must not replay any adapter call');

  await fs.writeFile(statePath, JSON.stringify({oldCovered: true, oldConflictCode: '0006', extraSkcs: sixteenExtras, oldActivityStock: 7, oldEndTime: '2098-06-30 23:59:59', allowDesired: true, allowCompensation: false, desiredCovered: false}), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const retryDir = path.join(temp, 'successful-replacement');
  const retried = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-successful-0006-replacement',
    '--out-dir', retryDir, '--journal-dir', path.join(retryDir, 'journals'),
  ], env);
  assert.equal(retried.code, 0, retried.stderr || retried.stdout);
  const retriedSummary = parseLastJson(retried.stdout);
  assert.equal(retriedSummary.status, 'replaced_all');
  assert.deepEqual(retriedSummary.desiredCoveredSkcs, ['SMOKE-SKC-1']);
  const journal = JSON.parse(await fs.readFile(path.resolve(ROOT, retriedSummary.journalPath), 'utf8').catch(async () => {
    const files = await fs.readdir(path.join(executeDir, 'journals'));
    return await fs.readFile(path.join(executeDir, 'journals', files[0]), 'utf8');
  }));
  assert.equal(journal.attempt, 1);
  assert.equal(journal.createAttempt.state, 'result_persisted');

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['COLLATERAL-SKC'],
    dropPreservedOnDelete: true,
    allowCompensation: true,
    allowDesired: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const collateralDir = path.join(temp, 'collateral-loss');
  const collateral = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-non-target-collateral-loss',
    '--out-dir', collateralDir, '--journal-dir', path.join(collateralDir, 'journals'),
  ], env);
  assert.equal(collateral.code, 4, collateral.stderr || collateral.stdout);
  const collateralSummary = parseLastJson(collateral.stdout);
  assert.equal(collateralSummary.safe, false);
  assert.equal(collateralSummary.status, 'unsafe_non_target_protection_changed');
  assert.deepEqual(collateralSummary.uncoveredSkcs, ['COLLATERAL-SKC']);

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['ATTRIBUTE-COLLATERAL-SKC'],
    mutatePreservedAfterDelete: true,
    allowCompensation: true,
    allowDesired: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const attributeCollateralDir = path.join(temp, 'collateral-attribute-change');
  const attributeCollateral = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-non-target-attribute-change',
    '--out-dir', attributeCollateralDir, '--journal-dir', path.join(attributeCollateralDir, 'journals'),
  ], env);
  assert.equal(attributeCollateral.code, 4, attributeCollateral.stderr || attributeCollateral.stdout);
  const attributeCollateralSummary = parseLastJson(attributeCollateral.stdout);
  assert.equal(attributeCollateralSummary.status, 'unsafe_non_target_protection_changed');
  assert.deepEqual(attributeCollateralSummary.uncoveredSkcs, ['ATTRIBUTE-COLLATERAL-SKC']);

  await fs.writeFile(statePath, JSON.stringify({
    oldCovered: true,
    oldConflictCode: '0006',
    extraSkcs: ['ACTIVITY-COLLATERAL-SKC'],
    mutateActivityAfterDelete: true,
    allowCompensation: true,
    allowDesired: true,
    desiredCovered: false,
  }), 'utf8');
  await fs.writeFile(eventPath, '', 'utf8');
  const activityCollateralDir = path.join(temp, 'collateral-activity-contract-change');
  const activityCollateral = await run([
    '--store', 'DL', '--port', '9999', '--rescue', rescuePath,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--transaction-id', 'smoke-non-target-activity-contract-change',
    '--out-dir', activityCollateralDir, '--journal-dir', path.join(activityCollateralDir, 'journals'),
  ], env);
  assert.equal(activityCollateral.code, 4, activityCollateral.stderr || activityCollateral.stdout);
  const activityCollateralSummary = parseLastJson(activityCollateral.stdout);
  assert.equal(activityCollateralSummary.compensation.ok, true,
    'target A compensation should succeed in this counterexample');
  assert.deepEqual(activityCollateralSummary.compensation.restoredCoveredSkcs, ['SMOKE-SKC-1']);
  assert.equal(activityCollateralSummary.safe, false,
    'target A restoration cannot prove preserved B retained its locked activity deadline/state');
  assert.equal(activityCollateralSummary.status, 'unsafe_non_target_protection_changed');
  assert.deepEqual(activityCollateralSummary.uncoveredSkcs, ['ACTIVITY-COLLATERAL-SKC']);

  console.log(JSON.stringify({
    ok: true,
    test: '0004_stays_blocked_and_0006_replacement_preserves_mixed_members_and_fails_closed_without_restore_evidence',
  }));
  }
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
