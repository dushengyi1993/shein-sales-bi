#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const source=fs.readFileSync(new URL('./cloud_marketing_repair_worker.sh',import.meta.url),'utf8');
const send=source.slice(source.indexOf('send_daily_group_report() {'),source.indexOf('\nFINAL_SCAN_OUT=',source.indexOf('send_daily_group_report() {')));
const start=source.indexOf('if [[ "$QUEUE_STATUS" == "completed" || "$QUEUE_STATUS" == "blocked" ]]; then');
assert.ok(start>0);
const branch=source.slice(start,source.indexOf('\nif (( IS_CLOUD_EXECUTION == 1 ))',start));
for(const queue of ['completed','blocked'])for(const code of [0,17,3]) {
  const shell=`set -euo pipefail
    QUEUE_STATUS=${queue}; DATE=2026-09-07; ROOT=/disposable; QUEUE_FILE=/disposable/queue; SEND_CODE=${code}
    write_state(){ printf 'state=%s\\n' "$1"; }
    terminal_report_ready(){ return 0; }
    run_final_readback(){ echo FINAL_READBACK; SEND_CODE=0; }
    node(){ return "$SEND_CODE"; }
    ${send}
    ${branch}`;
  const result=spawnSync(process.platform==='win32'?'wsl.exe':'bash',process.platform==='win32'?['-d','Ubuntu-24.04','--','bash','-s']:['-s'],{input:shell,encoding:'utf8',timeout:15000});
  assert.equal(result.status,code===17?17:0,result.stderr+'\n'+result.stdout);
  if(code===17)assert.match(result.stdout,/state=failed/);
  if(code===0){assert.match(result.stdout,queue==='blocked'?/state=blocked/:/state=ok/);assert.doesNotMatch(result.stdout,/FINAL_READBACK/);}
  if(code===3)assert.equal((result.stdout.match(/FINAL_READBACK/g)||[]).length,1);
}
console.log('marketing terminal worker: failed delivery propagates; ready terminal retry avoids a new business scan');
