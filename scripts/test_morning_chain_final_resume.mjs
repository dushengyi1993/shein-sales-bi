#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildDailyInventoryPlanHashPayload, stableInventoryHash} from '../lib/inventory_replenishment_policy.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'morning-final-resume-'));
const runDate = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
const date = new Date(`${runDate}T12:00:00Z`);
date.setUTCDate(date.getUTCDate() - 1);
const businessDate = date.toISOString().slice(0, 10);
const stores = ['CX','DL','DX','FY','HL','JSH','JY','LQ','MZ','NM','QH','QY','TS','TZ','TZZ','XC','XL','YJ','ZL'];
const runtime = path.join(root, 'runtime');
const markerRoot = path.join(root, 'state', 'pipeline-markers');
const stateDir = path.join(root, 'state', 'cloud_morning_chain');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const toWslPath = value => String(value).replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
const evidence = files => files.map(file => ({path:toWslPath(file),bytes:fs.statSync(file).size,sha256:hashFile(file)}));

try {
  fs.mkdirSync(path.join(root, 'scripts'), {recursive:true});
  fs.mkdirSync(path.join(root, 'config'), {recursive:true});
  fs.cpSync(path.join(repo, 'lib'), path.join(root, 'lib'), {recursive:true});
  fs.copyFileSync(path.join(repo, 'scripts', 'validate_daily_operating_refresh.mjs'), path.join(root, 'scripts', 'validate_daily_operating_refresh.mjs'));
  fs.copyFileSync(path.join(repo, 'scripts', 'build_morning_resume_evidence.mjs'), path.join(root, 'scripts', 'build_morning_resume_evidence.mjs'));
  fs.copyFileSync(path.join(repo, 'scripts', 'pipeline_marker.mjs'), path.join(root, 'scripts', 'pipeline_marker.mjs'));
  fs.copyFileSync(path.join(repo, 'scripts', 'check_release_source_state.mjs'), path.join(root, 'scripts', 'check_release_source_state.mjs'));
  fs.copyFileSync(path.join(repo, 'config', 'inventory_replenishment_policy.json'), path.join(root, 'config', 'inventory_replenishment_policy.json'));
  write(path.join(root, 'config', 'stores.json'), {stores:stores.map(storeKey => ({storeKey,enabled:true}))});
  const artifacts = [];
  for (const storeKey of stores) for (const domain of ['shein_links','shein_business_domains']) {
    const file = path.join(root, 'outputs', domain, storeKey, `${businessDate}.json`);
    write(file, {ok:true,date:businessDate,store:{storeKey}});
    artifacts.push({storeKey,domain,path:path.relative(root,file).split(path.sep).join('/'),bytes:fs.statSync(file).size,sha256:hashFile(file)});
  }
  const morningFile = path.join(stateDir, `${runDate}-all.json`);
  write(morningFile,{schemaVersion:'shein-morning-resume-evidence/v1',ok:true,date:businessDate,generatedAt:new Date().toISOString(),source:'existing_exact_date_store_artifacts',expectedStoreCount:19,artifactCount:38,stores,domains:['shein_links','shein_business_domains'],artifacts});
  const policy = JSON.parse(fs.readFileSync(path.join(root,'config','inventory_replenishment_policy.json'),'utf8'));
  const fetchedAt = new Date().toISOString();
  const sourceEvidence = [
    {store:'ET',file:'outputs/bi-portal/sections/inventoryTrend.json',fetchedAt,totalEtRows:1,matchedCurrentDayEtRows:1},
    {store:'BI_LINKS',file:'outputs/bi-portal/sections/linksData.json',fetchedAt},
    ...stores.map(store => ({store,file:`outputs/shein_openapi_products/${store}/latest.json`,fetchedAt,stockFailedChunkCount:0,sha256:'0'.repeat(64)})),
  ];
  const plan = {schemaVersion:'daily-inventory-replenishment-plan/v1',date:runDate,policyVersion:policy.policyVersion,executable:true,blockers:[],actionable:[],lowEtAllocations:[],sourceEvidence,counts:{enabledStores:19}};
  plan.payloadHash = stableInventoryHash(buildDailyInventoryPlanHashPayload(plan));
  const planFile = path.join(runtime,'plans',`daily-inventory-replenishment-${runDate}.json`);
  const resultFile = path.join(runtime,'results',`daily-inventory-replenishment-${runDate}.json`);
  write(planFile,plan);
  write(resultFile,{schemaVersion:'daily-inventory-replenishment-result/v1',generatedAt:fetchedAt,planHash:plan.payloadHash,policyVersion:plan.policyVersion,execute:true,executionMode:'automatic',reconcilePendingOnly:true,authorizationId:policy.execution.automaticExecution.authorizationId,authorizationContext:policy.execution.automaticExecution.allowedContext,unresolvedIntents:[],manualResolutionFences:[],manualResolutionTombstoneCount:0,results:[]});
  const inventoryMarker = path.join(markerRoot,runDate,'daily-inventory-guard.json');
  write(inventoryMarker,{ok:true,stage:'daily-inventory-guard',status:'done',runDate,businessDate,completedAt:fetchedAt,evidence:evidence([planFile,resultFile])});
  write(path.join(markerRoot,runDate,'daily-operating-refresh.json'),{ok:true,stage:'daily-operating-refresh',status:'done',runDate,businessDate,completedAt:fetchedAt,evidence:evidence([morningFile,inventoryMarker,planFile,resultFile])});

  const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  const command = [
    `export SHEIN_BI_ROOT=${shellQuote(toWslPath(root))}`,
    `export SHEIN_BI_MORNING_RUN_DATE=${shellQuote(runDate)}`,
    `export SHEIN_BI_MORNING_BUSINESS_DATE=${shellQuote(businessDate)}`,
    `export SHEIN_BI_MORNING_CHAIN_STATE_DIR=${shellQuote(toWslPath(stateDir))}`,
    `export SHEIN_BI_INVENTORY_RUNTIME_ROOT=${shellQuote(toWslPath(runtime))}`,
    `export SHEIN_BI_MORNING_CHAIN_LOG_DIR=${shellQuote(toWslPath(path.join(root,'logs')))}`,
    `bash ${shellQuote(toWslPath(path.join(repo, 'scripts', 'cloud_morning_chain.sh')))} all`,
  ].join('; ');
  const result = spawnSync('bash', ['-lc', command], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    env: process.env,
  });
  assert.equal(result.status, 0, `real chain final resume failed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /resume-skip complete daily-operating-refresh marker/);
  assert.doesNotMatch(result.stdout, /one daily coordinator is refreshing|run inventory stage/);
  console.log(JSON.stringify({ok:true,checks:['real_chain_semantic_resume_skip','no_substage_reexecution']},null,2));
} finally {
  await fsp.rm(root,{recursive:true,force:true});
}
