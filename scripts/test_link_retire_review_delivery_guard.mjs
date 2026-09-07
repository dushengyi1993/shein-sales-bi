import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {claimRetireReviewDelivery} from '../lib/link_retire_review_delivery_guard.mjs';
import {deliverCloudTeamReport} from '../lib/cloud_team_report_cloud.mjs';
import {sha256Bytes,computeDeliveryFingerprint} from '../lib/cloud_team_report_common.mjs';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'retire-review-claim-'));
try {
  const args = {root, date:'2026-09-07', fingerprint:'a'.repeat(64)};
  const concurrent = await Promise.allSettled([claimRetireReviewDelivery(args), claimRetireReviewDelivery(args)]);
  assert.equal(concurrent.filter(r=>r.status==='fulfilled').length, 1);
  await assert.rejects(claimRetireReviewDelivery({...args, fingerprint:'b'.repeat(64)}));
  const day = path.join(root, '2026-09-08');
  await fs.mkdir(path.join(day, 'c'.repeat(64)), {recursive:true});
  await assert.rejects(claimRetireReviewDelivery({...args,date:'2026-09-08'}), /already has delivery evidence/);
  const landingRoot=path.join(root,'receiver');
  const makeBundle=text=>({schemaVersion:'cloud-team-report/v1',automationId:'shein-3',businessDate:'2026-09-09',expectedAttachmentSha256:sha256Bytes(Buffer.from(text)),attachmentName:'review.xlsx',attachmentBase64:Buffer.from(text).toString('base64'),summaryBase64:Buffer.from('review').toString('base64')});
  const bundle=makeBundle('first');
  let calls=0;
  const options={landingRoot,config:{},spawnImpl:()=>{calls++;throw new Error('no real send in this fixture');}};
  const first=await deliverCloudTeamReport({...options,bundle});
  assert.equal(first.ok,false); // confirmed preflight config failure, no send
  await assert.rejects(deliverCloudTeamReport({...options,bundle:makeBundle('different')}), /another report|claim differs/);
  const repeat=await deliverCloudTeamReport({...options,bundle});
  assert.equal(repeat.fingerprint,first.fingerprint,'only same fingerprint can enter bounded retry');
  const fingerprint=computeDeliveryFingerprint({automationId:bundle.automationId,businessDate:bundle.businessDate,attachmentSha256:bundle.expectedAttachmentSha256});
  const stateFile=path.join(landingRoot,'shein-3',bundle.businessDate,fingerprint,'state.json');
  const state=JSON.parse(await fs.readFile(stateFile,'utf8'));
  state.items.summary.unknown=true;state.status='unknown';
  await fs.writeFile(stateFile,JSON.stringify(state));
  const unknown=await deliverCloudTeamReport({...options,config:{recipientChatId:'oc_fixture',defaultIdentity:'bot'},bundle});
  assert.equal(unknown.status,'unknown');assert.equal(calls,0);
  for(const status of ['pending','partial']) {
    const legacy=structuredClone(state);
    delete legacy.sendBoundaryVersion;
    legacy.status=status;
    for(const item of Object.values(legacy.items)){delete item.unknown;delete item.confirmedFailure;}
    if(status==='partial'){legacy.items.summary.accepted=true;legacy.items.summary.messageId='om_fixture';}
    await fs.writeFile(stateFile,JSON.stringify(legacy));
    const recovered=await deliverCloudTeamReport({...options,config:{recipientChatId:'oc_fixture',defaultIdentity:'bot'},bundle});
    assert.equal(recovered.status,'unknown');assert.equal(calls,0,`${status} without confirmed failure cannot spawn`);
  }
  const freshBundle={...makeBundle('fresh'),businessDate:'2026-09-10'};
  const freshFingerprint=computeDeliveryFingerprint({automationId:'shein-3',businessDate:freshBundle.businessDate,attachmentSha256:freshBundle.expectedAttachmentSha256});
  let attempted=0;
  await deliverCloudTeamReport({...options,config:{recipientChatId:'oc_fixture',defaultIdentity:'bot'},bundle:freshBundle,spawnImpl:()=>{
    const persisted=JSON.parse(fsSync.readFileSync(path.join(landingRoot,'shein-3',freshBundle.businessDate,freshFingerprint,'state.json')));
    assert.equal(persisted.items.summary.unknown,true,'in-flight marker must be durable before spawn');
    attempted++;throw new Error('fixture preflight spawn failure');
  }});
  assert.ok(attempted>0);
  console.log('PASS retire review day claim: concurrent, unknown, changed attachment, legacy evidence');
} finally { await fs.rm(root, {recursive:true,force:true}); }
