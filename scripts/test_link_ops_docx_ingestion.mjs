#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {
  DESCRIPTION_SOURCE_PROOF_DOCX,
  describeDescriptionMaterial,
  sha256Bytes,
  verifyDescriptionMaterialAgainstDocx,
} from '../lib/link_ops_product_descriptions.mjs';

const enLines = ['EN one', 'EN two', 'EN three', 'EN four', 'EN five'];
const arLines = ['عربي واحد', 'عربي اثنان', 'عربي ثلاثة', 'عربي أربعة', 'عربي خمسة'];
const zhLines = ['中文一', '中文二', '中文三', '中文四', '中文五'];
const xmlEscape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const paragraph = (style, text) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
const plainParagraph = lines => `<w:p>${lines.map((line, index) => `${index ? '<w:r><w:br/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`).join('')}</w:p>`;

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xedb88320) : (crc >>> 1);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, {deflate = false} = {}) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, rawValue] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(rawValue) ? rawValue : Buffer.from(rawValue, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const checksum = crc32(raw);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    local.push(localHeader, nameBytes, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + data.length;
  }
  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const rootRels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const documentXml = ({includeSellingPoints = true, malformed = false} = {}) => {
  const paragraphs = [paragraph('TitleEN', 'Review title EN'), paragraph('TitleAR', 'عنوان المراجعة')];
  if (includeSellingPoints) {
    paragraphs.push(...enLines.map(line => paragraph('SellingPointEN', line)));
    paragraphs.push(...arLines.map(line => paragraph('SellingPointAR', line)));
    paragraphs.push(...zhLines.map(line => paragraph('SellingPointZH', line)));
  }
  const body = paragraphs.join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  return malformed ? xml.replace('</w:t>', '') : xml;
};
const baseEntries = ({document = documentXml(), extra = []} = {}) => [
  ['[Content_Types].xml', contentTypes],
  ['_rels/.rels', rootRels],
  ['word/document.xml', document],
  ...extra,
];

const reviewedCopyBox = lines => `<w:tbl><w:tr><w:tc>${plainParagraph(lines)}</w:tc></w:tr></w:tbl>`;
const reviewedV3DocumentXml = ({englishOutsideTable = false, whitespaceLine = false, emptySixthSlot = false} = {}) => {
  const reviewedEnLines = whitespaceLine
    ? [` ${enLines[0]}`, ...enLines.slice(1)]
    : emptySixthSlot
      ? [enLines[0], enLines[1], '', ...enLines.slice(2)]
      : enLines;
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${plainParagraph(['Main Title 3｜reviewed'])}
${plainParagraph(['英文评分'])}${plainParagraph(['95/100'])}${plainParagraph(['1.5L 2-In-1 Blender With Grinder Cup, 400W Juicer Mixer With 3 Speeds and Pulse Control, 8 Stainless Steel Blades, Stainless Steel Cup, Leak-Proof Lid, Non-Slip Base, For Home Kitchen Drinks'])}
${plainParagraph(['阿文中文释义'])}${plainParagraph(['内部中文释义'])}${plainParagraph(['خلاط 2 في 1 بسعة 1.5 لتر مع كوب طحن، محرك 400 واط، 3 سرعات ونبض، 8 شفرات ستانلس، كوب ستانلس وغطاء محكم، للمشروبات اليومية في مطبخ المنزل'])}
${plainParagraph(['首测标题'])}
${plainParagraph(['9. 三语核心卖点'])}${plainParagraph(['英文卖点评分：96/100。'])}
${englishOutsideTable ? plainParagraph(reviewedEnLines) : reviewedCopyBox(reviewedEnLines)}
${plainParagraph(['阿文卖点评分：97/100。'])}${reviewedCopyBox(arLines)}
${plainParagraph(['中文仅用于内部核对'])}${reviewedCopyBox(zhLines)}
${plainParagraph(['10. next'])}<w:sectPr/></w:body></w:document>`;
};

const validDocx = zip(baseEntries(), {deflate: true});
const validSha = sha256Bytes(validDocx);
const verified = verifyDescriptionMaterialAgainstDocx(validDocx, {
  sourceFileBasename: 'review.docx',
  sourceFileSha256: validSha,
  section: 'auto',
});
assert.equal(verified.sectionUsed, 'docx');
assert.equal(verified.material.sourceFileSha256, validSha);
assert.deepEqual(verified.material.rows.en.lines, enLines);
assert.deepEqual(verified.material.rows.ar.lines, arLines);
assert.deepEqual(verified.material.rows['zh-cn'].lines, zhLines);
assert.equal(verified.extracted.title.en, 'Review title EN');
assert.equal(verified.extracted.title.ar, 'عنوان المراجعة');
assert.equal(describeDescriptionMaterial(verified.material).publishLanguages.join(','), 'ar,en');
assert.equal(DESCRIPTION_SOURCE_PROOF_DOCX, 'server_verified_docx_ooxml_fixed_structure');

const reviewedV3Docx = zip(baseEntries({
  document: reviewedV3DocumentXml(),
  extra: [['docProps/thumbnail.jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])]],
}), {deflate: true});
const reviewedV3 = verifyDescriptionMaterialAgainstDocx(reviewedV3Docx, {
  sourceFileBasename: 'reviewed-v3.docx',
  section: 'auto',
});
assert.deepEqual(reviewedV3.material.rows.en.lines, enLines);
assert.deepEqual(reviewedV3.material.rows.ar.lines, arLines);
assert.deepEqual(reviewedV3.material.rows['zh-cn'].lines, zhLines);
assert.match(reviewedV3.extracted.title.en, /^1\.5L 2-In-1 Blender/);
assert.match(reviewedV3.extracted.title.ar, /[\u0600-\u06ff]/);
for (const [name, document] of [
  ['outside-table.docx', reviewedV3DocumentXml({englishOutsideTable: true})],
  ['whitespace-drift.docx', reviewedV3DocumentXml({whitespaceLine: true})],
  ['blank-slot-drift.docx', reviewedV3DocumentXml({emptySixthSlot: true})],
]) {
  assert.throws(
    () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document})), {sourceFileBasename: name, section: 'auto'}),
    error => error?.code === 'DESCRIPTION_DOCX_SELLING_POINTS_REQUIRED',
  );
}

const deeplyNestedXml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:r>'.repeat(70)}<w:t>x</w:t>${'</w:r>'.repeat(70)}</w:body></w:document>`;
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document: deeplyNestedXml})), {sourceFileBasename: 'deep.docx', section: 'auto'}),
  error => error?.code === 'DESCRIPTION_DOCX_PACKAGE_INVALID' && /深度/.test(error.message),
);

const withDirectoryEntries = verifyDescriptionMaterialAgainstDocx(zip(baseEntries({extra: [['_rels/', Buffer.alloc(0)]]})), {
  sourceFileBasename: 'directory-entries.docx',
  section: 'auto',
});
assert.deepEqual(withDirectoryEntries.material.rows.en.lines, enLines);

const withMaterial = verifyDescriptionMaterialAgainstDocx(validDocx, {
  material: verified.material,
  sourceFileBasename: 'review.docx',
  sourceFileSha256: validSha,
  section: 'auto',
});
assert.deepEqual(withMaterial.material.rows, verified.material.rows);

assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(Buffer.from(validDocx), {
    sourceFileBasename: 'review.docm',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_PACKAGE_INVALID',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document: documentXml({includeSellingPoints: false})})), {
    sourceFileBasename: 'title-only.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_SELLING_POINTS_REQUIRED'
    && /ar\/en\/zh-cn|5行|禁止生成/.test(error.message),
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(Buffer.from(validDocx.subarray(0, validDocx.length - 7)), {
    sourceFileBasename: 'corrupt.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_PACKAGE_INVALID',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({extra: [['word/vbaProject.bin', Buffer.from('macro')]]})), {
    sourceFileBasename: 'macro.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({extra: [['_rels/external.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship TargetMode="External" Target="https://example.invalid"/></Relationships>']]})), {
    sourceFileBasename: 'external.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({extra: [['word/embeddings/oleObject1.xml', '<object/>']]})), {
    sourceFileBasename: 'embedded.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document: documentXml({malformed: true})})), {
    sourceFileBasename: 'malformed.docx',
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_PACKAGE_INVALID',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(validDocx, {
    material: {...verified.material, sourceFileSha256: '0'.repeat(64)},
    sourceFileBasename: 'review.docx',
    sourceFileSha256: '0'.repeat(64),
    section: 'auto',
  }),
  error => error?.code === 'DESCRIPTION_SOURCE_SHA_MISMATCH',
);
assert.throws(
  () => verifyDescriptionMaterialAgainstDocx(validDocx, {
    sourceFileBasename: 'review.docx',
    section: 's09',
  }),
  error => error?.code === 'DESCRIPTION_DOCX_SECTION_INVALID',
);

const enTitle = reviewedV3.extracted.title.en;
const arTitle = reviewedV3.extracted.title.ar;
const wrapDocument = body => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
const metadata = '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wpsCustomData="http://www.wps.cn/officeDocument/2013/wpsCustomData"><mc:AlternateContent><mc:Choice Requires="wpsCustomData"><wpsCustomData:typoFeatureVersion val="1"/></mc:Choice></mc:AlternateContent></w:settings>';
const directBody = `${plainParagraph(['Main Title 3｜reviewed'])}${reviewedCopyBox([enTitle])}${reviewedCopyBox([arTitle])}
${plainParagraph(['9. 三语核心卖点'])}${plainParagraph(['三种语言独立展示，便于直接复制；每种语言 5 条，逐行事实对应，卖点内容本身不加序号、不加项目符号。'])}
${reviewedCopyBox(enLines)}${reviewedCopyBox(arLines)}${reviewedCopyBox(zhLines)}${plainParagraph(['10. next'])}`;
const paragraphBody = `${plainParagraph(['Main Title 3'])}${plainParagraph(['英文标题'])}${plainParagraph([enTitle])}${plainParagraph(['阿拉伯语标题'])}${plainParagraph([arTitle])}
${plainParagraph(['9. 三语核心卖点'])}${plainParagraph(['English Selling Points'])}${enLines.map(line => plainParagraph([line])).join('')}
${plainParagraph(['Arabic Selling Points'])}${arLines.map(line => plainParagraph([line])).join('')}${plainParagraph(['中文卖点'])}${zhLines.map(line => plainParagraph([line])).join('')}${plainParagraph(['10. next'])}`;
const ordinaryFormatting = '<w:tbl><w:tblPr><w:tblBorders><w:insideH/><w:insideV/><w:left/><w:right/></w:tblBorders><w:tblCellMar><w:left/><w:right/></w:tblCellMar><w:tblInd/></w:tblPr><w:tr><w:tblPrEx/><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:pPr><w:keepNext/></w:pPr><w:bookmarkStart w:id="1"/><w:bookmarkEnd w:id="1"/></w:p></w:tc></w:tr></w:tbl>';
for (const [name, body] of [['direct', directBody], ['paragraph', paragraphBody]]) {
  const document = wrapDocument(body + reviewedCopyBox(['Main Title 3']) + ordinaryFormatting);
  const bytes = zip(baseEntries({document, extra: [['word/settings.xml', metadata], ['docProps/thumbnail.wmf', Buffer.from([0xd7, 0xcd, 0xc6, 0x9a])]]}));
  const opts = {sourceFileBasename: `${name}.docx`, section: 'auto'};
  const result = verifyDescriptionMaterialAgainstDocx(bytes, opts);
  assert.deepEqual(result.extracted.title, {en: enTitle, ar: arTitle});
  for (const [language, lines] of [['en', enLines], ['ar', arLines], ['zh-cn', zhLines]]) assert.deepEqual(result.material.rows[language].lines, lines);
  assert.deepEqual(verifyDescriptionMaterialAgainstDocx(bytes, {...opts, material: result.material}).material.rows, result.material.rows);
  const drift = structuredClone(result.material); drift.rows.en.lines[0] += ' changed';
  assert.throws(() => verifyDescriptionMaterialAgainstDocx(bytes, {...opts, material: drift}));
  assert.throws(() => verifyDescriptionMaterialAgainstDocx(bytes, {...opts, material: result.material, sourceFileSha256: '0'.repeat(64)}), error => error.code === 'DESCRIPTION_SOURCE_SHA_MISMATCH');
}
for (const body of [
  directBody.replace(reviewedCopyBox(zhLines), reviewedCopyBox(enLines)),
  directBody.replace(reviewedCopyBox(enLines), reviewedCopyBox([...enLines, 'sixth'])),
  directBody.replace(reviewedCopyBox(arLines), reviewedCopyBox([...arLines.slice(0, 4), '中文'])),
  directBody.replace(reviewedCopyBox(enLines), plainParagraph(enLines)),
  paragraphBody.replace(plainParagraph(['Arabic Selling Points']), plainParagraph(['sixth']) + plainParagraph(['Arabic Selling Points'])),
  paragraphBody.replace(plainParagraph([enLines[0]]), plainParagraph([enLines[0], ''])),
  paragraphBody.replace('Arabic Selling Points', 'English Selling Points'),
  paragraphBody + plainParagraph(['Main Title 3']),
]) assert.throws(() => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document: wrapDocument(body)})), {sourceFileBasename: 'invalid.docx'}));
for (const value of [metadata.replace('val="1"', 'val="x"'), metadata.replace('</mc:Choice>', '<w:object/></mc:Choice>'), metadata.replace('</mc:AlternateContent>', '<mc:Fallback/></mc:AlternateContent>')]) {
  assert.throws(() => verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document: wrapDocument(directBody), extra: [['word/settings.xml', value]]})), {sourceFileBasename: 'invalid.docx'}), error => error.code === 'DESCRIPTION_DOCX_FORBIDDEN_CONTENT');
}
console.log('link_ops_docx_ingestion: fixed and reviewed layouts, ordinary metadata, exact source/row locks and incomplete/ambiguous structure checks passed');

const rtlDocument = reviewedV3DocumentXml().replaceAll('<w:p>', '<w:p><w:pPr><w:bidi w:val="1"/></w:pPr>').replaceAll('<w:r>', '<w:r><w:rPr><w:rtl/></w:rPr>');
const rtlBytes = zip(baseEntries({document:rtlDocument}));
const rtlVerified = verifyDescriptionMaterialAgainstDocx(rtlBytes, {sourceFileBasename:'rtl.docx',section:'auto'});
assert.deepEqual(rtlVerified.material.rows.ar.lines, arLines);
assert.deepEqual(rtlVerified.material.rows.en.lines, enLines);
assert.equal(rtlVerified.material.sourceFileSha256,sha256Bytes(rtlBytes));
const badDirection = zip(baseEntries({document:reviewedV3DocumentXml().replace('<w:body>','<w:body><w:bidi/>')}));
assert.throws(()=>verifyDescriptionMaterialAgainstDocx(badDirection,{sourceFileBasename:'bad-rtl.docx',section:'auto'}),error=>error.code==='DESCRIPTION_DOCX_STRUCTURE_INVALID');

const labelledDocument = reviewedV3DocumentXml()
  .replace('Main Title 3｜reviewed', 'Main Title 3 - reviewed')
  .replace(plainParagraph(['英文评分'])+plainParagraph(['95/100']), plainParagraph(['英文标题']))
  .replace(plainParagraph(['阿文中文释义'])+plainParagraph(['内部中文释义']), plainParagraph(['阿文标题']))
  .replace('英文卖点评分：96/100。','English Selling Points')
  .replace('阿文卖点评分：97/100。','Arabic Selling Points')
  .replace('中文仅用于内部核对','中文卖点');
const labelledVerified = verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document:labelledDocument})),{sourceFileBasename:'labelled.docx',section:'auto'});
assert.deepEqual(labelledVerified.material.rows.en.lines,enLines);
assert.deepEqual(labelledVerified.material.rows.ar.lines,arLines);
assert.equal(labelledVerified.extracted.title.en,reviewedV3.extracted.title.en);
assert.equal(labelledVerified.extracted.title.ar,reviewedV3.extracted.title.ar);
assert.throws(()=>verifyDescriptionMaterialAgainstDocx(zip(baseEntries({document:labelledDocument.replace('English Selling Points','Arabic Selling Points')})),{sourceFileBasename:'ambiguous.docx',section:'auto'}),error=>error.code==='DESCRIPTION_DOCX_STRUCTURE_INVALID');
