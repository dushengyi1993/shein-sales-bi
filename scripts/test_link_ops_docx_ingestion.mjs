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

console.log('link_ops_docx_ingestion: fixed and reviewed-V3 OOXML, directory/thumbnail compatibility, byte SHA/material binding, title-only, corrupt, macro, external-link, embedded-object, malformed-XML, and section fail-closed checks passed');
