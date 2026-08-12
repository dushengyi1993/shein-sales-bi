#!/usr/bin/env node
/**
 * Unit tests for lib/link_ops_description_material_extract.mjs: deterministic
 * strict extraction from the unique section#s09 (EN/AR code labels, ZH
 * displaybox), including decoys, duplicate sections, empty lines, entities,
 * byte differences and ambiguous labels.
 */
import crypto from 'node:crypto';
import {
  extractTrilingualCoreSellingPoints,
  extractTrilingualCoreSellingPointsAuto,
  verifyDescriptionMaterialAgainstHtml,
} from '../lib/link_ops_description_material_extract.mjs';

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

const enLines = ['EN one', 'EN two', 'EN three', 'EN four', 'EN five'];
const arLines = ['سطر أول', 'سطر ثانٍ', 'سطر ثالث', 'سطر رابع', 'سطر خامس'];
const zhLines = ['中文一', '中文二', '中文三', '中文四', '中文五'];
const code = lines => `<code>${lines.join('\n')}</code>`;

function validHtml(overrides = {}) {
  const displaybox = overrides.displaybox !== undefined
    ? overrides.displaybox
    : `<div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>`;
  return `<!doctype html><html><body>
<section id="s08"><article><h3>英文</h3><code>DECOY should not be picked</code></article></section>
<section id="s09">
  <p>说明：英文、阿文、中文分别展示三语核心卖点，请逐字复制不要改写。</p>
  <article class="card"><h3>英文</h3>${code(enLines)}</article>
  <article class="card"><h3>阿文</h3>${code(arLines)}</article>
  ${displaybox}
</section>
</body></html>`;
}

const html = validHtml();
const bytes = Buffer.from(html, 'utf8');
const fileSha = crypto.createHash('sha256').update(bytes).digest('hex');

// --- happy path: labels 英文/阿文 + displaybox ---
const extracted = extractTrilingualCoreSellingPoints(html);
check('en exactly 5 lines', extracted.en.lines.length, 5);
check('ar exactly 5 lines', extracted.ar.lines.length, 5);
check('zh exactly 5 lines', extracted['zh-cn'].lines.length, 5);
check('en lines byte-exact', JSON.stringify(extracted.en.lines), JSON.stringify(enLines));
check('ar lines byte-exact', JSON.stringify(extracted.ar.lines), JSON.stringify(arLines));
check('zh lines byte-exact', JSON.stringify(extracted['zh-cn'].lines), JSON.stringify(zhLines));

// --- source-only construction (no material JSON) ---
const sourceOnly = verifyDescriptionMaterialAgainstHtml(html, bytes, {sourceFileBasename: 'SK-11004.html', sourceFileSha256: fileSha});
check('source-only material built from actual bytes sha', sourceOnly.material.sourceFileSha256, fileSha);
check('source-only material sourceLabel basename', sourceOnly.material.sourceLabel, 'SK-11004.html');
check('source-only material row sha matches joined lines', sourceOnly.material.rows.en.sha256, crypto.createHash('sha256').update(enLines.join('\n'), 'utf8').digest('hex'));
throws('source-only explicit wrong source sha rejected', () => verifyDescriptionMaterialAgainstHtml(html, bytes, {
  sourceFileBasename: 'SK-11004.html',
  sourceFileSha256: 'f'.repeat(64),
}), /DESCRIPTION_SOURCE_SHA_MISMATCH/);

// --- verify path with a provided material JSON ---
function materialFromExtracted() {
  const rows = {};
  for (const language of ['en', 'ar', 'zh-cn']) {
    const lines = extracted[language].lines;
    rows[language] = {
      language,
      lines: [...lines],
      sha256: crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex'),
    };
  }
  return {schemaVersion: 1, sourceLabel: 'SK-11004.html', sourceFileSha256: fileSha, rows};
}
const verified = verifyDescriptionMaterialAgainstHtml(html, bytes, {
  material: materialFromExtracted(),
  sourceFileBasename: 'SK-11004.html',
  sourceFileSha256: fileSha,
});
check('verify path material accepted when byte-exact', verified.material.rows.en.lines[0], 'EN one');

// --- byte difference between material rows and actual section ---
throws('material row byte difference rejected', () => {
  const m = materialFromExtracted();
  m.rows.en.lines[0] = 'EN ONE';
  verifyDescriptionMaterialAgainstHtml(html, bytes, {material: m, sourceFileBasename: 'SK-11004.html', sourceFileSha256: fileSha});
}, /DESCRIPTION_MATERIAL_MISMATCH_SOURCE/);
throws('material declared source sha mismatch rejected', () => {
  const m = materialFromExtracted();
  m.sourceFileSha256 = 'f'.repeat(64);
  verifyDescriptionMaterialAgainstHtml(html, bytes, {material: m, sourceFileBasename: 'SK-11004.html', sourceFileSha256: m.sourceFileSha256});
}, /DESCRIPTION_SOURCE_SHA_MISMATCH/);
throws('material row declared sha mismatch rejected', () => {
  const m = materialFromExtracted();
  m.rows.ar.sha256 = 'e'.repeat(64);
  verifyDescriptionMaterialAgainstHtml(html, bytes, {material: m, sourceFileBasename: 'SK-11004.html', sourceFileSha256: fileSha});
}, /DESCRIPTION_MATERIAL_SHA_MISMATCH/);

// --- decoys: similar paragraph in another section is not picked ---
const decoyHtml = validHtml();
const withNote = decoyHtml.replace(
  '<section id="s08"><article><h3>英文</h3><code>DECOY should not be picked</code></article></section>',
  '<section id="s08"><article><h3>英文</h3><code>英文卖点诱饵一\n英文卖点诱饵二\n英文卖点诱饵三\n英文卖点诱饵四\n英文卖点诱饵五</code></article></section>',
);
check('decoy section ignored', JSON.stringify(extractTrilingualCoreSellingPoints(withNote).en.lines), JSON.stringify(enLines));

// --- duplicate s09 rejected ---
const dupHtml = validHtml().replace('</section>', '</section><section id="s09"><article><h3>英文</h3><code>a\nb\nc\nd\ne</code></article></section>');
throws('duplicate section#s09 rejected', () => extractTrilingualCoreSellingPoints(dupHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);

// --- missing s09 rejected ---
throws('missing section#s09 rejected', () => extractTrilingualCoreSellingPoints('<html><body><p>no section</p></body></html>'), /DESCRIPTION_HTML_EXTRACT_INVALID/);

// --- empty line inside code -> line count mismatch rejected ---
const emptyLineHtml = validHtml({
  displaybox: undefined,
}).replace(code(enLines), '<code>EN one\n\nEN three\nEN four\nEN five</code>');
throws('code block with empty line rejected', () => extractTrilingualCoreSellingPoints(emptyLineHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);

// --- entities decoded byte-preserving ---
const entityHtml = validHtml({
  displaybox: undefined,
}).replace('<h3>英文</h3>', '<h3>英文</h3>').replace('EN one', 'EN one &amp; half &quot;quote&quot; 100&#37;');
const entityExtracted = extractTrilingualCoreSellingPoints(entityHtml);
check('entity decoded in line', entityExtracted.en.lines[0], 'EN one & half "quote" 100%');

// --- displaybox structures ---
// nested div per line must still yield the 5 child lines
const nestedBoxHtml = validHtml({
  displaybox: `<div class="displaybox">${zhLines.map(line => `<div><span>${line}</span></div>`).join('')}</div>`,
});
check('displaybox with nested children still 5 lines', JSON.stringify(extractTrilingualCoreSellingPoints(nestedBoxHtml)['zh-cn'].lines), JSON.stringify(zhLines));
const displayboxDefault = `<div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>`;
// displaybox with 4 children rejected
const fourChildHtml = validHtml({
  displaybox: `<div class="displaybox">${zhLines.slice(0, 4).map(line => `<div>${line}</div>`).join('')}</div>`,
});
throws('displaybox with 4 children rejected', () => extractTrilingualCoreSellingPoints(fourChildHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);
// displaybox with stray text rejected
const strayTextHtml = validHtml({
  displaybox: `<div class="displaybox">stray${zhLines.map(line => `<div>${line}</div>`).join('')}</div>`,
});
throws('displaybox stray container text rejected', () => extractTrilingualCoreSellingPoints(strayTextHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);
// missing displaybox but zh-labeled code fallback
const zhCodeHtml = validHtml({
  displaybox: undefined,
}).replace(displayboxDefault, `<article class="card"><h3>中文</h3>${code(zhLines)}</article>`);
check('zh code fallback when displaybox missing', JSON.stringify(extractTrilingualCoreSellingPoints(zhCodeHtml)['zh-cn'].lines), JSON.stringify(zhLines));
// displaybox and zh code disagree -> rejected
const disagreeHtml = validHtml({
  displaybox: `<div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div>`,
}).replace(displayboxDefault, `<div class="displaybox">${zhLines.map(line => `<div>${line}</div>`).join('')}</div><article class="card"><h3>中文</h3>${code(['不同一', '不同二', '不同三', '不同四', '不同五'])}</article>`);
throws('displaybox and zh code disagreement rejected', () => extractTrilingualCoreSellingPoints(disagreeHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);

// --- ambiguous / unlabeled labels rejected ---
const ambiguousHtml = validHtml({
  displaybox: undefined,
}).replace(`<h3>英文</h3>${code(enLines)}`, `<h3>英文/阿文</h3>${code(enLines)}`);
throws('ambiguous combined label rejected', () => extractTrilingualCoreSellingPoints(ambiguousHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);
const unlabeledHtml = validHtml({
  displaybox: undefined,
}).replace(`<h3>英文</h3>${code(enLines)}`, `<h3>Language</h3>${code(enLines)}`)
  .replace(`<h3>阿文</h3>${code(arLines)}`, `<h3>Language</h3>${code(arLines)}`);
throws('unlabeled codes rejected (no fuzzy guess)', () => extractTrilingualCoreSellingPoints(unlabeledHtml), /DESCRIPTION_HTML_EXTRACT_INVALID/);

// --- legacy s9: direct pre dir plus Unicode script evidence is deterministic ---
const legacyDirected = `<!doctype html><html><body><section id="s9">
<pre class="copybox copytext" dir="ltr">${code(enLines)}</pre>
<pre class="copybox copytext right" dir="rtl">${code(arLines)}</pre>
<pre class="copybox copytext" dir="ltr">${code(zhLines)}</pre>
</section></body></html>`;
const legacyDirectedRows = extractTrilingualCoreSellingPointsAuto(legacyDirected);
check('legacy directed s9 selected', legacyDirectedRows.sectionUsed, 's9');
check('legacy directed en exact', JSON.stringify(legacyDirectedRows.extracted.en.lines), JSON.stringify(enLines));
check('legacy directed ar exact', JSON.stringify(legacyDirectedRows.extracted.ar.lines), JSON.stringify(arLines));
check('legacy directed zh exact', JSON.stringify(legacyDirectedRows.extracted['zh-cn'].lines), JSON.stringify(zhLines));
throws('legacy rtl without Arabic script rejected', () => extractTrilingualCoreSellingPointsAuto(
  legacyDirected.replace(`dir="rtl">${code(arLines)}`, `dir="rtl">${code(enLines)}`),
), /DESCRIPTION_HTML_EXTRACT_INVALID/);
throws('legacy ltr Arabic conflict rejected', () => extractTrilingualCoreSellingPointsAuto(
  legacyDirected.replace(`dir="rtl">${code(arLines)}`, `dir="ltr">${code(arLines)}`),
), /DESCRIPTION_HTML_EXTRACT_INVALID/);

const failed = checks.filter(row => !row.pass);
for (const row of failed) console.error(`FAIL ${row.label}\n  expected: ${row.expected}\n  actual:   ${row.actual}`);
console.log(`link_ops_description_material_extract: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exit(1);
