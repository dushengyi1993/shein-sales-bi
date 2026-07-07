#!/usr/bin/env node
/**
 * Static guard for the SK-270 cloud execution handoff.
 *
 * This test is intentionally local-only. It validates that the handoff package
 * remains a cloud-only continuation guide for all 19 SK-270 new-publish stores,
 * with no old-link path and no sample gate, and that it cannot be mistaken for
 * evidence of completed batch submission.
 */
import fs from 'node:fs/promises';

const HANDOFF_FILE = 'tmp/sk270-batch-prep/sk270-cloud-execution-handoff.local-only.json';
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
const checklistText = (handoff.cloudRunChecklist || []).join('\n');
const cleanupPolicyText = String(handoff.hardBoundary?.cloudStorageCleanupPolicy || '');
const hardBoundaryText = JSON.stringify(handoff.hardBoundary || {});
const productText = JSON.stringify(handoff.product || {});
const blockers = [];

check('handoff marked ok', handoff.ok, true);
check('local-only handoff mode', handoff.mode, 'local_handoff_only_no_openapi');
check('source draft is local-only SK-270 draft', handoff.sourceDraft, value => /sk270-batch-draft-plan\.local-only\.json$/.test(String(value)));
check('local OpenAPI hard boundary', handoff.hardBoundary?.localOpenApi || '', value => /forbidden/.test(String(value)) && /Windows\/Codex/.test(String(value)));
check('real execution cloud only and no sample gate', handoff.hardBoundary?.realExecution || '', value => /shein-bi-tencent/.test(String(value)) && /link-ops-execute/.test(String(value)) && /all 19/.test(String(value)) && /dry-run/.test(String(value)));
check('sample gate not required', handoff.hardBoundary?.doNotBatchBefore, 'not_required_user_said_go_ahead_2026-07-07_all_19_stores');
check('remaining gate is no sample but per-store gates retained', handoff.remainingGate || '', value => /none_user_said_go_ahead_all_19/.test(String(value)) && /dry-run/.test(String(value)) && /readback/.test(String(value)));
check('sample evidence absent', handoff.sampleEvidenceAlreadyRecorded, null);
check('19 store handoff assignments', stores.length, 19);
check('unique stores', new Set(stores).size, 19);
check('old link stores none', oldLinkStores.join(','), '');
check('new publish stores count', newPublishStores.length, 19);
check('remaining old link updates none', (handoff.remainingBatch?.oldLinkUpdates || []).join(','), '');
check('remaining new publish count all 19', (handoff.remainingBatch?.newPublishes || []).length, 19);
check('remaining execute stores count all 19', (handoff.remainingBatch?.executeStores || []).length, 19);
check('no already submitted samples recorded', (handoff.remainingBatch?.skipAlreadySubmittedSamples || []).join(','), '');
check('counts old links zero', handoff.counts?.oldLinkUpdates, 0);
check('counts new publishes 19', handoff.counts?.newPublishes, 19);
check('remaining old link updates count zero', handoff.counts?.remainingOldLinkUpdates, 0);
check('remaining new publishes count 19', handoff.counts?.remainingNewPublishes, 19);
check('sample confirmed statuses zero/absent', statusCounts.sample_confirmed_already_submitted_no_repeat || 0, 0);
check('pending cloud batch statuses count', statusCounts.pending_cloud_batch_execution, 19);
check('six image sets', handoff.counts?.imageSets, 6);
check('title group sizes 7/6/6', handoff.counts?.titleGroups || {}, value => value.title1 === 7 && value.title2 === 6 && value.title3 === 6);
check('source attribute product recorded', productText, value => /MZ/.test(value) && /sv260203191147519923696/.test(value));
check('supply price range product recorded', handoff.product?.supplyPriceRange || {}, value => value.min === 423.9 && value.max === 571 && value.currency === 'SAR');
check('new publish goods sn policy', handoff.hardBoundary?.newPublishGoodsSnPolicy || '', value => /standardGoodsSn=SK-270厨师机/.test(String(value)) && /supplier_code/.test(String(value)) && /supplier_sku/.test(String(value)) && /Product Model/.test(String(value)) && /source raw supplier_code/.test(String(value)));
check('custom image/title policy recorded', hardBoundaryText, value => /customImageTitlePolicy/.test(value) && /uploaded image URLs/.test(value) && /titleEn\/titleAr/.test(value));
check('new publish assignments use standard display goods sn', [...new Set(assignments.map(a => a.standardGoodsSn))].join(','), 'SK-270厨师机');
check('new publish assignments retain model code for audit', [...new Set(assignments.map(a => a.standardGoodsSnCode || ''))].join(','), 'SK-270');
check('all assignments use MZ source store', [...new Set(assignments.map(a => a.sourceStoreForAttributes || ''))].join(','), 'MZ');
check('all assignments use source SKC', [...new Set(assignments.map(a => a.sourceSkcForAttributes || ''))].join(','), 'sv260203191147519923696');
check('all assignments use price range', assignments, value => value.every(a => a.supplyPriceRange?.min === 423.9 && a.supplyPriceRange?.max === 571 && a.supplyPriceRange?.currency === 'SAR'));
check('title1 stores', (handoff.titleGroups?.title1 || []).join(','), 'DL,DX,FY,NM,HL,JY,LQ');
check('title2 stores', (handoff.titleGroups?.title2 || []).join(','), 'ZL,TS,MZ,CX,XL,YJ');
check('title3 stores', (handoff.titleGroups?.title3 || []).join(','), 'QY,QH,TZ,JSH,TZZ,XC');
check('cloud task pipeline mechanism recorded', handoff.cloudExecutionMechanism || {}, value => /link-ops-execute/.test(JSON.stringify(value)) && /SHEIN_OPENAPI_SUBMIT/.test(JSON.stringify(value)) && /openapi-image-asset/.test(JSON.stringify(value)));
check('cloud readiness records custom composition blocker', handoff.cloudReadiness || {}, value => value.localStaticReady === true && value.cloudExecutorNeedsCustomImageTitleComposition === true && /uploaded image URLs/.test(String(value.blocker || '')) && /SK-270厨师机/.test(String(value.blocker || '')));
check('checklist records all-19/no-sample and per-store gates', checklistText, value => /all 19 SK-270/.test(value) && /no sample gate/.test(value) && /dry-run/.test(value) && /readback/.test(value));
check('checklist says no local OpenAPI', checklistText, value => /Do not run SHEIN OpenAPI from local Windows\/Codex/.test(value));
check('checklist requires image upload manifest', checklistText, value => /upload/.test(value) && /manifest/.test(value) && /returned SHEIN URL/.test(value));
check('checklist requires source attributes plus custom images titles', checklistText, value => /sourceStore=MZ/.test(value) && /sv260203191147519923696/.test(value) && /uploaded image URLs/.test(value) && /titleEn\/titleAr/.test(value));
check('checklist requires standard display goods sn for new publishes', checklistText, value => /standardGoodsSn SK-270厨师机/.test(value) && /supplier_code/.test(value) && /supplier_sku/.test(value));
check('checklist requires randomized price range', checklistText, value => /423\.90-571\.00 SAR/.test(value) && /randomized/.test(value));
check('checklist requires info.success success rule', checklistText, value => /info\.success !== false/.test(value));
check('checklist requires no duplicate successful submissions', checklistText, value => /Do not retry or duplicate/.test(value) && /successful/.test(value));
check('cloud storage cleanup policy recorded', cleanupPolicyText, value => /shein-bi-tencent/.test(value) && /source images/.test(value) && /intermediate/.test(value) && /before\/after sizes/.test(value) && /never delete final summaries/.test(value) && /platform receipt logs/.test(value));
check('checklist requires cloud temp image cleanup evidence', checklistText, value => /clean cloud source images/.test(value) && /upload staging files/.test(value) && /before\/after sizes/.test(value) && /keep final summary\/log\/manifest\/audit evidence/.test(value) && /platform receipt logs/.test(value));

for (const assignment of assignments) {
  if (assignment.path !== 'new_publish_copy_from_template') blockers.push(`${assignment.store}:unexpected-path:${assignment.path}`);
  if (!assignment.mainCover) blockers.push(`${assignment.store}:missing-main-cover`);
  if (!assignment.carouselSecondCover) blockers.push(`${assignment.store}:missing-carousel-second-cover`);
  if (!assignment.squareImage) blockers.push(`${assignment.store}:missing-square-image`);
  if (!assignment.imageSourceDir || !/SK-270厨师机/.test(assignment.imageSourceDir)) blockers.push(`${assignment.store}:missing-image-source-dir`);
  if (!assignment.titleEn) blockers.push(`${assignment.store}:missing-title-en`);
  if (!assignment.titleAr) blockers.push(`${assignment.store}:missing-title-ar`);
  if (!assignment.frontendDetailImages?.length) blockers.push(`${assignment.store}:missing-frontend-detail-images`);
  if (assignment.detailCount > 11) blockers.push(`${assignment.store}:detail-count-over-11`);
  if (assignment.skuImage === undefined) blockers.push(`${assignment.store}:missing-sku-image-field`);
}

check('handoff assignments have required custom publish fields', blockers, value => value.length === 0);

const ok = checks.every(c => c.pass);
console.log(JSON.stringify({ok, handoffFile: HANDOFF_FILE, checks, blockers}, null, 2));
if (!ok) process.exit(1);
