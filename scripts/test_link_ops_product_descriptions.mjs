#!/usr/bin/env node
/**
 * Unit tests for lib/link_ops_product_descriptions.mjs (Phase A strict
 * reviewed-material description contracts). No network, no SHEIN.
 */
import {
  buildDescriptionPayloadRows,
  buildPrepareDescriptionsCliOutput,
  describeDescriptionMaterial,
  describePublishPayloadDescription,
  evaluateDescriptionReadback,
  descriptionBindingRequestKey,
  sha256StableJson,
  sha256Utf8,
  validateDescriptionBindingLock,
  validateDescriptionMaterialJson,
  validatePublishPayloadDescription,
  verifyDescriptionMaterialSourceFile,
  DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  DESCRIPTION_SOURCE_PROOF,
  DESCRIPTION_SOURCE_PROOF_S9,
  DESCRIPTION_NAME_MAX_CHARS,
} from '../lib/link_ops_product_descriptions.mjs';

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : actual === expected;
  checks.push({label, actual, expected: typeof expected === 'function' ? (expected.name || 'predicate') : expected, pass});
  return pass;
}
function throws(label, fn, codeRe = null) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  const pass = caught !== null && (!codeRe || codeRe.test(caught.code || ''));
  checks.push({label, actual: caught ? `${caught.code}: ${caught.message}` : 'no throw', expected: `throw${codeRe ? ` ${codeRe}` : ''}`, pass});
  return pass;
}
function jsonText(value) { return JSON.stringify(value); }

const arLines = ['سطر عربي واحد', 'سطر عربي اثنان', 'سطر عربي ثلاثة', 'سطر عربي أربعة', 'سطر عربي خمسة'];
const enLines = ['EN selling point one', 'EN selling point two', 'EN selling point three', 'EN selling point four', 'EN selling point five'];
const zhLines = ['中文卖点一', '中文卖点二', '中文卖点三', '中文卖点四', '中文卖点五'];

function material(overrides = {}) {
  const rows = {
    ar: {language: 'ar', lines: [...arLines], sha256: sha256Utf8(arLines.join('\n'))},
    en: {language: 'en', lines: [...enLines], sha256: sha256Utf8(enLines.join('\n'))},
    'zh-cn': {language: 'zh-cn', lines: [...zhLines], sha256: sha256Utf8(zhLines.join('\n'))},
  };
  return {
    schemaVersion: 1,
    sourceLabel: 'SK-11004-review.html',
    sourceFileSha256: 'a'.repeat(64),
    rows,
    ...overrides,
  };
}

// --- strict material validation ---
const valid = validateDescriptionMaterialJson(material());
check('valid material accepted', valid.rows.ar.lines[0], arLines[0]);
throws('sourceLabel with path rejected', () => validateDescriptionMaterialJson(material({sourceLabel: 'C:/Users/x/SK-11004.html'})), /DESCRIPTION_MATERIAL_INVALID/);
throws('schemaVersion mismatch rejected', () => validateDescriptionMaterialJson(material({schemaVersion: 2})), /DESCRIPTION_MATERIAL_INVALID/);
throws('extra language row rejected', () => validateDescriptionMaterialJson(material({rows: {...material().rows, fr: {language: 'fr', lines: ['a', 'b', 'c', 'd', 'e'], sha256: 'b'.repeat(64)}}})), /DESCRIPTION_MATERIAL_INVALID/);
throws('missing zh-cn row rejected', () => {
  const m = material();
  delete m.rows['zh-cn'];
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('wrong row keys rejected', () => {
  const m = material();
  m.rows.en = {language: 'en', lines: [...enLines], extra: 1};
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('4 lines rejected', () => {
  const m = material();
  m.rows.en.lines = enLines.slice(0, 4);
  m.rows.en.sha256 = sha256Utf8(enLines.slice(0, 4).join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('6 lines rejected', () => {
  const m = material();
  m.rows.en.lines = [...enLines, 'extra'];
  m.rows.en.sha256 = sha256Utf8([...enLines, 'extra'].join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('empty line rejected', () => {
  const m = material();
  m.rows.en.lines = ['a', '', 'c', 'd', 'e'];
  m.rows.en.sha256 = sha256Utf8(['a', '', 'c', 'd', 'e'].join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('embedded newline rejected', () => {
  const m = material();
  m.rows.en.lines[0] = 'a\nb';
  m.rows.en.sha256 = sha256Utf8(m.rows.en.lines.join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('HTML angle bracket rejected', () => {
  const m = material();
  m.rows.en.lines[0] = 'a <b> c';
  m.rows.en.sha256 = sha256Utf8(m.rows.en.lines.join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('astral emoji U+1F600 rejected', () => {
  const m = material();
  m.rows.en.lines[0] = 'selling point \u{1F600}';
  m.rows.en.sha256 = sha256Utf8(m.rows.en.lines.join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('BMP emoji U+2600 rejected', () => {
  const m = material();
  m.rows.en.lines[0] = 'selling point \u2600';
  m.rows.en.sha256 = sha256Utf8(m.rows.en.lines.join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('composed emoji with FE0F rejected', () => {
  const m = material();
  m.rows.en.lines[0] = 'selling point \u2764\uFE0F';
  m.rows.en.sha256 = sha256Utf8(m.rows.en.lines.join('\n'));
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
check('degree sign 360° accepted (no false positive)', validateDescriptionMaterialJson(material({
  rows: {
    ...material().rows,
    en: {language: 'en', lines: ['360° rotation', ...enLines.slice(1)], sha256: sha256Utf8(['360° rotation', ...enLines.slice(1)].join('\n'))},
  },
})).rows.en.lines[0], '360° rotation');
check('Arabic/Chinese text accepted', validateDescriptionMaterialJson(material()).rows['zh-cn'].lines[0], '中文卖点一');
throws('declared sha mismatch rejected', () => {
  const m = material();
  m.rows.ar.sha256 = 'f'.repeat(64);
  validateDescriptionMaterialJson(m);
}, /DESCRIPTION_MATERIAL_INVALID/);
throws('sourceFileSha256 mismatch with caller-provided value rejected', () => {
  validateDescriptionMaterialJson(material(), {sourceFileSha256: 'b'.repeat(64)});
}, /DESCRIPTION_MATERIAL_INVALID/);
check('sourceFileSha256 verified when caller provides matching value', validateDescriptionMaterialJson(material(), {sourceFileSha256: 'a'.repeat(64)}).sourceFileSha256, 'a'.repeat(64));

// --- payload rows: fixed ar/en order, \n join, no rewrite ---
const payloadRows = buildDescriptionPayloadRows(material());
check('payload row count', payloadRows.length, 2);
check('payload order fixed ar then en', payloadRows.map(row => row.language).join(','), 'ar,en');
check('payload ar name joins 5 lines with \\n', payloadRows[0].name, arLines.join('\n'));
check('payload en name joins 5 lines with \\n', payloadRows[1].name, enLines.join('\n'));
throws('name over 5000 chars rejected', () => {
  const long = ['x'.repeat(1001), 'y'.repeat(1001), 'z'.repeat(1001), 'w'.repeat(1001), 'v'.repeat(1001)];
  const m = material();
  m.rows.en = {language: 'en', lines: long, sha256: sha256Utf8(long.join('\n'))};
  buildDescriptionPayloadRows(m);
}, /DESCRIPTION_NAME_TOO_LONG/);
check('DESCRIPTION_NAME_MAX_CHARS constant', DESCRIPTION_NAME_MAX_CHARS, 5000);

// --- description summary: hashes only, no text ---
const summary = describeDescriptionMaterial(material());
const summaryText = jsonText(summary);
check('summary has no line text', summaryText, text => !text.includes('selling point') && !text.includes('سطر') && !text.includes('中文卖点'));
check('summary has all three language hashes', [summary.hashes.ar, summary.hashes.en, summary.hashes['zh-cn']].every(h => /^[a-f0-9]{64}$/.test(h)), true);
check('summary publishLanguages fixed', summary.publishLanguages.join(','), 'ar,en');
check('summary lineCounts all 5', [summary.lineCounts.ar, summary.lineCounts.en, summary.lineCounts['zh-cn']].every(n => n === 5), true);

// --- source-file byte verification ---
const sourceBytes = Buffer.from(JSON.stringify({reviewed: 'SK-11004', content: arLines.join('\n')}), 'utf8');
throws('source sha mismatch rejected', () => verifyDescriptionMaterialSourceFile(material(), sourceBytes, {sourceFileBasename: 'x.html'}), /DESCRIPTION_SOURCE_SHA_MISMATCH/);
const verifiedMaterial = verifyDescriptionMaterialSourceFile(
  material({sourceFileSha256: sha256Utf8(sourceBytes)}),
  sourceBytes,
  {sourceFileBasename: 'C:/tmp/SK-11004.html'},
);
check('verified material source sha equals actual bytes sha', verifiedMaterial.sourceFileSha256, sha256Utf8(sourceBytes));
check('verified material sourceLabel forced to basename', verifiedMaterial.sourceLabel, 'SK-11004.html');

// --- publish payload description gate ---
const payloadWithDesc = {
  multi_language_desc_list: [
    {language: 'ar', name: arLines.join('\n')},
    {language: 'en', name: enLines.join('\n')},
  ],
};
check('payload gate ok for exact ar/en 5 lines', validatePublishPayloadDescription(payloadWithDesc).ok, true);
check('payload gate blocks missing desc', validatePublishPayloadDescription({}).ok, false);
check('payload gate rejects extra fr language', validatePublishPayloadDescription({multi_language_desc_list: [...payloadWithDesc.multi_language_desc_list, {language: 'fr', name: 'a\nb\nc\nd\ne'}]}).ok, false);
check('payload gate rejects duplicate ar', validatePublishPayloadDescription({multi_language_desc_list: [payloadWithDesc.multi_language_desc_list[0], payloadWithDesc.multi_language_desc_list[0], payloadWithDesc.multi_language_desc_list[1]]}).ok, false);
check('payload gate rejects unknown language only', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'de', name: 'a\nb\nc\nd\ne'}]}).ok, false);
check('payload gate rejects camelCase-only field', validatePublishPayloadDescription({multiLanguageDescList: payloadWithDesc.multi_language_desc_list}).ok, false);
check('payload gate rejects snake and camel fields together', validatePublishPayloadDescription({
  ...payloadWithDesc,
  multiLanguageDescList: payloadWithDesc.multi_language_desc_list,
}).ok, false);
check('payload gate rejects extra row keys', validatePublishPayloadDescription({multi_language_desc_list: [
  {...payloadWithDesc.multi_language_desc_list[0], extra: true},
  payloadWithDesc.multi_language_desc_list[1],
]}).ok, false);
check('payload gate rejects non-string row values', validatePublishPayloadDescription({multi_language_desc_list: [
  {language: 'ar', name: 123},
  payloadWithDesc.multi_language_desc_list[1],
]}).ok, false);
check('payload gate rejects 4 lines', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'ar', name: arLines.slice(0, 4).join('\n')}, {language: 'en', name: enLines.join('\n')}]}).ok, false);
check('payload gate rejects empty name', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'ar', name: ''}, {language: 'en', name: enLines.join('\n')}]}).ok, false);
check('payload gate rejects HTML in name', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'ar', name: '<p>x</p>'}, {language: 'en', name: enLines.join('\n')}]}).ok, false);
check('payload gate rejects emoji in name', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'ar', name: 'x \u{1F600}'}, {language: 'en', name: enLines.join('\n')}]}).ok, false);
check('payload gate rejects name over limit', validatePublishPayloadDescription({multi_language_desc_list: [{language: 'ar', name: 'x'.repeat(5001)}, {language: 'en', name: enLines.join('\n')}]}).ok, false);
const payloadSummary = describePublishPayloadDescription(payloadWithDesc);
check('payload description summary count', payloadSummary.descriptionCount, 2);
check('payload description summary languages', payloadSummary.descriptionLanguages.join(','), 'ar,en');
check('payload description summary hashes match material', payloadSummary.descriptionHashes.en, sha256Utf8(enLines.join('\n')));

// --- binding lock ---
const bindingTask = {
  id: 'lot_description_binding_unit',
  targets: {stores: ['NM'], writeStores: ['NM']},
  openapiPublishPayload: payloadWithDesc,
  publishAssetBinding: {bindingFingerprint: 'f'.repeat(64)},
};
const baseTaskRevision = 7;
const binding = {
  schemaVersion: 1,
  kind: 'copy_product_draft',
  sourceApproved: true,
  authority: 'human_reviewed_source',
  sourceProof: DESCRIPTION_SOURCE_PROOF,
  targetStore: 'NM',
  boundAt: '2026-08-11T00:00:00.000Z',
  boundByUser: 'description-unit',
  baseTaskRevision,
  bindingRequestKey: descriptionBindingRequestKey({
    taskId: bindingTask.id,
    targetStore: 'NM',
    baseTaskRevision,
    contentSha256: summary.contentSha256,
    sourceProof: DESCRIPTION_SOURCE_PROOF,
  }),
  sourceLabel: 'SK-11004-review.html',
  sourceByteLength: 1234,
  sourceFileSha256: 'a'.repeat(64),
  contentSha256: summary.contentSha256,
  hashes: summary.hashes,
  publishLanguages: ['ar', 'en'],
  lineCounts: summary.lineCounts,
  newPayloadHash: sha256StableJson(payloadWithDesc),
  payloadHashAlgorithm: DESCRIPTION_PAYLOAD_HASH_ALGORITHM,
  imageBindingFingerprint: 'f'.repeat(64),
};
check('binding lock ok when hashes and exact metadata match', validateDescriptionBindingLock({...bindingTask, descriptionMaterialBinding: binding}, payloadWithDesc).ok, true);
check('binding lock rejects source proof flip without matching identity', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, sourceProof: DESCRIPTION_SOURCE_PROOF_S9},
}, payloadWithDesc).ok, false);
const legacyS09BindingRequestKey = descriptionBindingRequestKey({
  taskId: bindingTask.id,
  targetStore: 'NM',
  baseTaskRevision,
  contentSha256: summary.contentSha256,
});
check('binding lock keeps pre-upgrade s09 identity compatible', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, bindingRequestKey: legacyS09BindingRequestKey},
}, payloadWithDesc).ok, true);
check('binding lock never accepts pre-upgrade key for s9 proof', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {
    ...binding,
    sourceProof: DESCRIPTION_SOURCE_PROOF_S9,
    bindingRequestKey: legacyS09BindingRequestKey,
  },
}, payloadWithDesc).ok, false);
const driftedPayload = {
  multi_language_desc_list: [
    {language: 'ar', name: arLines.join('\n')},
    {language: 'en', name: ['rewritten', ...enLines.slice(1)].join('\n')},
  ],
};
check('binding lock blocks rewritten payload', validateDescriptionBindingLock({...bindingTask, descriptionMaterialBinding: binding}, driftedPayload).ok, false);
check('binding lock blocks desc without binding', validateDescriptionBindingLock({}, payloadWithDesc).ok, false);
check('binding lock blocks when no binding and no desc', validateDescriptionBindingLock({}, {}).ok, false);
check('binding lock rejects forged payload hash', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, newPayloadHash: 'b'.repeat(64)},
}, payloadWithDesc).ok, false);
check('binding lock rejects extra metadata', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, extra: true},
}, payloadWithDesc).ok, false);
check('binding lock rejects wrong target store', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, targetStore: 'DL'},
}, payloadWithDesc).ok, false);
check('binding lock rejects corrupt contentSha', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, contentSha256: 'f'.repeat(64)},
}, payloadWithDesc).ok, false);
check('binding lock rejects missing source sha', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, sourceFileSha256: ''},
}, payloadWithDesc).ok, false);
check('binding lock rejects missing zh audit hash', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, hashes: {...binding.hashes, 'zh-cn': ''}},
}, payloadWithDesc).ok, false);
check('binding lock rejects wrong authority marker', validateDescriptionBindingLock({
  ...bindingTask,
  descriptionMaterialBinding: {...binding, authority: 'generated'},
}, payloadWithDesc).ok, false);

// --- live spu-info description readback ---
const spuInfoExact = {
  productMultiDescList: [
    {language: 'ar', productDesc: arLines.join('\n')},
    {language: 'en', productDesc: enLines.join('\n')},
  ],
};
const readbackExact = evaluateDescriptionReadback(binding, spuInfoExact);
check('readback exact matched', readbackExact.ok && readbackExact.status, 'description_readback_matched');
const readbackMissing = evaluateDescriptionReadback(binding, {productMultiDescList: [{language: 'en', productDesc: enLines.join('\n')}]});
check('readback missing ar -> ok false', readbackMissing.ok, false);
check('readback missing status', readbackMissing.status, 'description_readback_missing');
const readbackDuplicate = evaluateDescriptionReadback(binding, {
  productMultiDescList: [
    {language: 'ar', productDesc: arLines.join('\n')},
    {language: 'ar', productDesc: arLines.join('\n')},
    {language: 'en', productDesc: enLines.join('\n')},
  ],
});
check('readback duplicate -> ok false', readbackDuplicate.ok, false);
check('readback duplicate status', readbackDuplicate.status, 'description_readback_duplicate');
const readbackMismatch = evaluateDescriptionReadback(binding, {
  productMultiDescList: [
    {language: 'ar', productDesc: arLines.join('\n')},
    {language: 'en', productDesc: ['drifted', ...enLines.slice(1)].join('\n')},
  ],
});
check('readback mismatch -> ok false', readbackMismatch.ok, false);
check('readback mismatch status', readbackMismatch.status, 'description_readback_mismatch');
check('readback summary carries hashes only', jsonText(readbackMismatch.summary), text => !text.includes('selling point') && !text.includes('سطر'));
const readbackUnverifiable = evaluateDescriptionReadback(null, spuInfoExact);
check('readback without binding but live desc -> unverifiable', readbackUnverifiable.ok, false);
check('readback not required when no binding and no desc', evaluateDescriptionReadback(null, {productMultiDescList: []}).status, 'description_readback_not_required');

// --- CLI output builder: hashes only ---
const cliOutput = buildPrepareDescriptionsCliOutput({
  summary,
  binding: {sameTask: true, targetStore: 'NM', newPayloadHash: 'c'.repeat(64), preflightInvalidated: true, imageBindingFingerprintUnchanged: true},
  dryRun: {
    state: 'openapi_product_preflight_ready',
    ok: true,
    blockerCount: 0,
    payloadHash: 'd'.repeat(64),
    descriptionCount: 2,
    descriptionLanguages: ['ar', 'en'],
    descriptionLineCounts: {ar: 5, en: 5},
    descriptionHashes: {ar: summary.hashes.ar, en: summary.hashes.en},
    descriptionBindingLocked: true,
  },
  taskId: 'lot_test',
  store: 'NM',
});
const cliText = jsonText(cliOutput);
check('CLI output contains no description text', cliText, text => !text.includes('selling point') && !text.includes('سطر') && !text.includes('中文卖点'));
check('CLI output carries hashes', cliOutput.material.contentSha256.length === 64 && cliOutput.bound.newPayloadHash.length === 64 && cliOutput.dryRun.payloadHash.length === 64, true);
check('CLI output source label is basename only', cliOutput.material.sourceLabel, 'SK-11004-review.html');
check('CLI output only reports ok when binding and dry-run locks are complete', cliOutput.ok, true);
check('CLI output reports failure when dry-run payload hash is absent', buildPrepareDescriptionsCliOutput({
  summary,
  binding: {sameTask: true, targetStore: 'NM', newPayloadHash: 'c'.repeat(64), preflightInvalidated: true, imageBindingFingerprintUnchanged: true},
  dryRun: {state: 'blocked', ok: false, blockerCount: 1},
  taskId: 'lot_test',
  store: 'NM',
}).ok, false);

const failed = checks.filter(row => !row.pass);
for (const row of failed) console.error(`FAIL ${row.label}\n  expected: ${row.expected}\n  actual:   ${row.actual}`);
console.log(`link_ops_product_descriptions: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
