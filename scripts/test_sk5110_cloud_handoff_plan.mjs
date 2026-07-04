#!/usr/bin/env node
/**
 * Static guard for the SK-5110 cloud execution handoff.
 *
 * This test is intentionally local-only. It validates that the handoff package
 * remains a cloud-only continuation guide after the HL/DX sample gate, and that
 * it cannot be mistaken for evidence of completed batch submission.
 */
import fs from 'node:fs/promises';

const HANDOFF_FILE = 'tmp/sk5110-batch-prep/sk5110-cloud-execution-handoff.local-only.json';
const handoff = JSON.parse(await fs.readFile(HANDOFF_FILE, 'utf8'));
const checks = [];

function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

const assignments = handoff.assignments || [];
const stores = assignments.map(a => a.store);
const oldLinkStores = assignments.filter(a => a.path === 'old_link_update_title_images').map(a => a.store).sort();
const newPublishStores = assignments.filter(a => a.path === 'new_publish_copy_from_template').map(a => a.store).sort();
const statusCounts = handoff.counts?.statuses || {};
const checklistText = (handoff.cloudRunChecklist || []).join('\\n');
const cleanupPolicyText = String(handoff.hardBoundary?.cloudStorageCleanupPolicy || '');
const blockers = [];

check('handoff marked ok', handoff.ok, true);
check('local-only handoff mode', handoff.mode, 'local_handoff_only_no_openapi');
check('source draft is local-only draft', handoff.sourceDraft, value => /sk5110-batch-draft-plan\.local-only\.json$/.test(String(value)));
check('local OpenAPI hard boundary', handoff.hardBoundary?.localOpenApi || '', value => /forbidden/.test(String(value)) && /Windows\/Codex/.test(String(value)));
check('real execution cloud only', handoff.hardBoundary?.realExecution || '', value => /shein-bi-tencent/.test(String(value)) && /HL\/DX samples confirmed/.test(String(value)));
check('sample approval recorded', handoff.hardBoundary?.doNotBatchBefore, 'satisfied_user_sample_approval_2026-07-03');
check('remaining gate cleared but dry-run gates retained', handoff.remainingGate || '', value => /none_after_user_approved_HL_DX_samples/.test(String(value)) && /dry-run/.test(String(value)));
check('19 store handoff assignments', stores.length, 19);
check('unique stores', new Set(stores).size, 19);
check('old link stores exactly HL,NM', oldLinkStores.join(','), 'HL,NM');
check('new publish stores count', newPublishStores.length, 17);
check('remaining old link update excludes submitted HL sample', (handoff.remainingBatch?.oldLinkUpdates || []).join(','), 'NM');
check('remaining new publish count excludes submitted DX sample', (handoff.remainingBatch?.newPublishes || []).length, 16);
check('remaining execute stores count is NM plus 16 new publishes', (handoff.remainingBatch?.executeStores || []).length, 17);
check('skip already submitted samples recorded', (handoff.remainingBatch?.skipAlreadySubmittedSamples || []).join(','), 'HL,DX');
check('new publish goods sn policy', handoff.hardBoundary?.newPublishGoodsSnPolicy || '', value => /standardGoodsSn=SK-5110电磁炉/.test(String(value)) && /supplier_code/.test(String(value)) && /supplier_sku/.test(String(value)) && /Product Model/.test(String(value)) && /source raw supplier_code/.test(String(value)));
check('new publish goods sn policy documents frontend display name layer', handoff.hardBoundary?.newPublishGoodsSnPolicy || '', value => /frontend\/task goods-sn field/.test(String(value)) && /Chinese product name/.test(String(value)));
check('new publish assignments use standard display goods sn', [...new Set(assignments.filter(a => a.path === 'new_publish_copy_from_template').map(a => a.standardGoodsSn))].join(','), 'SK-5110电磁炉');
check('new publish assignments retain model code for audit', [...new Set(assignments.filter(a => a.path === 'new_publish_copy_from_template').map(a => a.standardGoodsSnCode || ''))].join(','), 'SK-5110');
check('count old links', handoff.counts?.oldLinkUpdates, 2);
check('count new publishes', handoff.counts?.newPublishes, 17);
check('remaining old link updates count', handoff.counts?.remainingOldLinkUpdates, 1);
check('remaining new publishes count', handoff.counts?.remainingNewPublishes, 16);
check('sample confirmed statuses retained for already executed samples', statusCounts.sample_confirmed_already_submitted_no_repeat, 2);
check('pending cloud batch statuses count', statusCounts.pending_cloud_batch_execution, 17);
check('HL sample remains submitted evidence', assignments.find(a => a.store === 'HL')?.status, 'sample_confirmed_already_submitted_no_repeat');
check('DX sample remains submitted evidence', assignments.find(a => a.store === 'DX')?.status, 'sample_confirmed_already_submitted_no_repeat');
check('cloud task pipeline mechanism recorded', handoff.cloudExecutionMechanism || {}, value => /link-ops-execute/.test(JSON.stringify(value)) && /SHEIN_OPENAPI_SUBMIT/.test(JSON.stringify(value)));
check('cloud readiness blocks execute until standard guard deployed', handoff.cloudReadiness || {}, value => value.localStaticReady === true && value.cloudExecutorNeedsStandardGoodsSnPatch === true && /taskStandardGoodsSn/.test(String(value.blocker || '')));
check('title1 stores', (handoff.titleGroups?.title1 || []).join(','), 'JSH,DL,TZZ,CX,HL,TS,TZ');
check('title2 stores', (handoff.titleGroups?.title2 || []).join(','), 'DX,LQ,XC,MZ,NM,YJ');
check('title3 stores', (handoff.titleGroups?.title3 || []).join(','), 'JY,QY,XL,FY,QH,ZL');
check('checklist records sample approval/no-repeat and per-store gates', checklistText, value => /Skip HL and DX sample tasks/.test(value) && /dry-run/.test(value) && /hash/.test(value));
check('checklist says no local OpenAPI', checklistText, value => /不要在本机直连 SHEIN OpenAPI/.test(value));
check('checklist requires dry-run hash', checklistText, value => /dry-run/.test(value) && /hash/.test(value));
check('checklist requires standard display goods sn for new publishes', checklistText, value => /标准货号 SK-5110电磁炉/.test(value));
check('checklist requires info.success success rule', checklistText, value => /info\.success !== false/.test(value));
check('checklist requires no duplicate successful submissions', checklistText, value => /不重复提交已成功项/.test(value));
check('cloud storage cleanup policy recorded', cleanupPolicyText, value => /shein-bi-tencent/.test(value) && /source images/.test(value) && /intermediate/.test(value) && /before\/after sizes/.test(value) && /never delete final summaries/.test(value) && /platform receipt logs/.test(value));
check('checklist requires cloud temp image cleanup evidence', checklistText, value => /clean cloud source images/.test(value) && /upload staging files/.test(value) && /before\/after sizes/.test(value) && /keep final summary\/log\/manifest\/audit evidence/.test(value) && /platform receipt logs/.test(value));

for (const assignment of assignments) {
  if (!assignment.mainCover) blockers.push(`${assignment.store}:missing-main-cover`);
  if (!assignment.carouselSecondCover) blockers.push(`${assignment.store}:missing-carousel-second-cover`);
  if (!assignment.squareImage) blockers.push(`${assignment.store}:missing-square-image`);
  if (!assignment.skuImage) blockers.push(`${assignment.store}:missing-sku-image`);
  if (assignment.detailCount > 11) blockers.push(`${assignment.store}:detail-count-over-11`);
  if (!['old_link_update_title_images', 'new_publish_copy_from_template'].includes(assignment.path)) {
    blockers.push(`${assignment.store}:unknown-path:${assignment.path}`);
  }
}

check('handoff assignments have required image roles', blockers, value => value.length === 0);

const ok = checks.every(c => c.pass);
console.log(JSON.stringify({ok, handoffFile: HANDOFF_FILE, checks, blockers}, null, 2));
if (!ok) process.exit(1);
