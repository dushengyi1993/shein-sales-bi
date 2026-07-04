#!/usr/bin/env node
/**
 * Static guard for the SK-5110 local batch draft.
 *
 * This test is intentionally local-only. It validates the prepared store/title
 * and image-role draft without uploading images or calling SHEIN OpenAPI.
 */
import fs from 'node:fs/promises';

const DRAFT_FILE = 'tmp/sk5110-batch-prep/sk5110-batch-draft-plan.local-only.json';
const draft = JSON.parse(await fs.readFile(DRAFT_FILE, 'utf8'));
const checks = [];

function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

const stores = draft.assignments.map(a => a.store);
const titleMap = Object.fromEntries(draft.assignments.map(a => [a.store, a.titleGroup]));
const forbiddenCoverRe = /产品封面|纯产品.*封面|产品外观.*封面|外观封面|AB测试|A\s*B\s*测试|ab[-_\s]*test/i;
const offenders = [];

check('draft marked ok', draft.ok, true);
check('local-only mode', draft.mode, 'local_draft_only_no_openapi');
check('19 store assignments', stores.length, 19);
check('unique stores', new Set(stores).size, 19);
check('old link stores exactly HL,NM', draft.assignments.filter(a => a.executionPath === 'old_link_update_title_images').map(a => a.store).sort().join(','), 'HL,NM');
check('remaining old link update excludes submitted HL sample', (draft.remainingBatch?.oldLinkUpdates || []).join(','), 'NM');
const newPublishAssignments = draft.assignments.filter(a => a.executionPath === 'new_publish_copy_from_template');
check('new publish stores count', newPublishAssignments.length, 17);
check('remaining new publish count excludes submitted DX sample', (draft.remainingBatch?.newPublishes || []).length, 16);
check('new publish goods sn policy', draft.rules?.newPublishGoodsSnPolicy || '', value => /standardGoodsSn/.test(String(value)) && /supplier_code/.test(String(value)) && /supplier_sku/.test(String(value)) && /source/.test(String(value)));
check('new publish assignments use standard display goods sn', [...new Set(newPublishAssignments.map(a => a.standardGoodsSn))].join(','), 'SK-5110电磁炉');
check('new publish assignments retain model code for audit', [...new Set(newPublishAssignments.map(a => a.standardGoodsSnCode || ''))].join(','), 'SK-5110');
check('new publish goods sn policy documents frontend display name layer', draft.rules?.newPublishGoodsSnPolicy || '', value => /前端|frontend/.test(String(value)) && /Chinese product name/.test(String(value)) && /Product Model/.test(String(value)));
check('XC uses dopamine set', draft.assignments.find(a => a.store === 'XC')?.imageSet, '04-多巴胺活力烹饪方案');
check('image set usage max two stores', Math.max(...Object.values(draft.imageSetUsage || {})), v => v <= 2);
check('title1 mapping', ['JSH', 'DL', 'TZZ', 'CX', 'HL', 'TS', 'TZ'].map(s => titleMap[s]).join(','), 'title1,title1,title1,title1,title1,title1,title1');
check('title2 mapping', ['DX', 'LQ', 'XC', 'MZ', 'NM', 'YJ'].map(s => titleMap[s]).join(','), 'title2,title2,title2,title2,title2,title2');
check('title3 mapping', ['JY', 'QY', 'XL', 'FY', 'QH', 'ZL'].map(s => titleMap[s]).join(','), 'title3,title3,title3,title3,title3,title3');

for (const assignment of draft.assignments) {
  const summary = assignment.imageRoleSummary || {};
  const submitted = [
    summary.mainCover,
    summary.carouselSecondCover,
    summary.squareImage,
    summary.skuImage,
    ...(summary.frontendDetailImages || []),
  ].filter(Boolean);
  for (const name of submitted) {
    if (forbiddenCoverRe.test(name)) offenders.push(`${assignment.store}:${name}`);
  }
  if ((summary.frontendDetailImages || [])[0] !== summary.mainCover) offenders.push(`${assignment.store}:first-detail-not-main-cover`);
  if ((summary.frontendDetailImages || []).length > 11) offenders.push(`${assignment.store}:detail-count-over-11`);
  const paramIndex = (summary.frontendDetailImages || []).findIndex(name => /参数|规格/.test(name));
  const firstSceneIndex = (summary.frontendDetailImages || []).findIndex((name, index) => index > 0 && /场景|厨房|晚餐|早餐|露台|家庭|木屋/.test(name));
  if (paramIndex > 0 && firstSceneIndex > 0 && paramIndex > firstSceneIndex) offenders.push(`${assignment.store}:parameter-after-scene`);
}

check('no forbidden product/AB cover in submitted roles and detail invariants hold', offenders, value => value.length === 0);
check('local OpenAPI explicitly forbidden', draft.rules?.localOpenApi || '', value => /forbidden/.test(String(value)) && /cloud/.test(String(value)));
check('sample approval recorded', draft.rules?.sampleGate || '', value => /HL\/DX samples confirmed/.test(String(value)) && /2026-07-03/.test(String(value)));
check('HL/DX samples marked confirmed and no-repeat', ['HL', 'DX'].map(s => draft.assignments.find(a => a.store === s)?.status).join(','), 'sample_confirmed_already_submitted_no_repeat,sample_confirmed_already_submitted_no_repeat');
check('new publish assignments ready for cloud batch or already submitted sample', [...new Set(newPublishAssignments.map(a => a.status))].sort().join(','), 'pending_cloud_batch_execution,sample_confirmed_already_submitted_no_repeat');

const ok = checks.every(c => c.pass);
console.log(JSON.stringify({ok, draftFile: DRAFT_FILE, checks, offenders}, null, 2));
if (!ok) process.exit(1);
