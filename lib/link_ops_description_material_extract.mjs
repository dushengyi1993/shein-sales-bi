#!/usr/bin/env node
/**
 * Deterministic strict extractor for the reviewed 审核资料 HTML (Phase A).
 *
 * This round's NM source is an HTML file whose 三语核心卖点 section is the
 * unique `<section id="s09">`. Inside that section:
 *   - English lines live in a <code> element labeled 英文/English/EN,
 *   - Arabic lines live in a <code> element labeled 阿拉伯/العربية/Arabic/AR,
 *   - Chinese lines live in a "displaybox" container (class*="displaybox").
 *
 * The extractor is byte-exact and never rewrites text:
 *   - it only decodes HTML entities (&amp; &lt; &gt; &quot; &#39; &nbsp; and
 *     numeric references), converts <br> and block-end tags to line breaks,
 *     strips remaining tags, then splits on CR/LF and drops lines that are
 *     exactly the empty string (container pretty-print artifacts);
 *   - every remaining line must match the material row byte-for-byte;
 *   - exactly 5 lines per language are required, otherwise reject.
 *
 * No LLM and no fuzzy language classification is used. Section must be unique;
 * labels must be unambiguous; any byte difference between the material rows
 * and the actual section text is a rejection.
 */
import crypto from 'node:crypto';
import {sha256Utf8} from './link_ops_product_descriptions.mjs';

const SECTION_ID_RE = /<section\b[^>]*\bid\s*=\s*["']s09["'][^>]*>([\s\S]*?)<\/section>/gi;
const CODE_RE = /<code\b[^>]*>([\s\S]*?)<\/code>/gi;
const DISPLAYBOX_OPEN_RE = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bclass\s*=\s*["'][^"']*displaybox[^"']*["'][^>]*>/gi;
const HEADING_RE = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
const TAG_RE = /<(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*?)?)(\/?)>/g;

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: '\u00A0',
  '#160': '\u00A0',
  ensp: '\u2002',
  '#8194': '\u2002',
  emsp: '\u2003',
  '#8195': '\u2003',
};

const EN_LABEL_RE = /(?:英文|英语|English|\bEN\b)/i;
const AR_LABEL_RE = /(?:阿文|阿拉伯|العربية|Arabic|\bAR\b)/i;
const ZH_LABEL_RE = /(?:中文|汉语|Chinese|\bZH\b)/i;

export class DescriptionHtmlExtractError extends Error {
  constructor(message, {code = 'DESCRIPTION_HTML_EXTRACT_INVALID', details = {}} = {}) {
    super(message);
    this.name = 'DescriptionHtmlExtractError';
    this.code = code;
    this.details = details;
  }
}

function extractError(message, details = {}) {
  return new DescriptionHtmlExtractError(message, {code: 'DESCRIPTION_HTML_EXTRACT_INVALID', details});
}

function decodeEntities(text) {
  return String(text ?? '').replace(/&([a-zA-Z#0-9]+);/g, (match, name) => {
    const key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ENTITY_MAP, key)) return ENTITY_MAP[key];
    if (/^#x[0-9a-f]+$/i.test(key)) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (/^#[0-9]+$/.test(key)) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return match;
  });
}

function stripTagsAndNormalizeBreaks(text) {
  return String(text ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|tr|h[1-6]|section|table|ul|ol)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

function extractLines(text) {
  const decoded = decodeEntities(stripTagsAndNormalizeBreaks(text));
  return decoded
    .split(/\r\n|\n|\r/)
    .map(line => line.replace(/\r$/, ''))
    .filter(line => line !== '');
}

function findUniqueS09Section(htmlText) {
  const matches = [...String(htmlText ?? '').matchAll(SECTION_ID_RE)];
  if (!matches.length) {
    throw extractError('HTML 中没有找到唯一的 <section id="s09"> 三语核心卖点章节');
  }
  if (matches.length > 1) {
    throw extractError(`HTML 中 section#s09 出现 ${matches.length} 次，必须唯一`);
  }
  return matches[0];
}

function classifyCodeBlocks(section) {
  const codes = [...section.matchAll(CODE_RE)];
  const blocks = [];
  if (!codes.length) return blocks;
  // Nearest-heading scoping: each <code> inherits the language label from the
  // last heading inside its own article/card container. Prefix text such as a
  // note “英文、阿文、中文分别…” before the first code is never scanned.
  const headings = [...section.matchAll(HEADING_RE)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    level: Number(match[1]),
    text: decodeEntities(stripTagsAndNormalizeBreaks(match[2])).replace(/\s+/g, ' ').trim(),
  }));
  const codeSpans = codes.map(match => ({start: match.index, end: match.index + match[0].length}));
  const containerStack = [];
  const CONTAINER_RE = /^(article|section|li|fieldset)$/;
  const CARD_CLASS_RE = /\bcard\b/i;
  let headingIndex = 0;
  TAG_RE.lastIndex = 0;
  let searchFrom = 0;
  for (const match of codes) {
    // Advance the tag scan up to this code's start.
    const until = match.index;
    while (searchFrom < until) {
      const nextTag = section.indexOf('<', searchFrom);
      if (nextTag < 0 || nextTag >= until) break;
      TAG_RE.lastIndex = nextTag;
      const tag = TAG_RE.exec(section);
      if (!tag) break;
      searchFrom = tag.index + tag[0].length;
      const closing = tag[1] === '/';
      const name = tag[2].toLowerCase();
      const attrs = tag[3] || '';
      if (!closing && tag[4] !== '/') {
        if (CONTAINER_RE.test(name) || (name === 'div' && CARD_CLASS_RE.test(attrs))) {
          containerStack.push({name, lastHeading: ''});
        }
      } else if (closing) {
        const top = containerStack[containerStack.length - 1];
        if (top && top.name === name) containerStack.pop();
      }
      // Track the last heading opened inside the current top container.
      while (headingIndex < headings.length && headings[headingIndex].end <= searchFrom) {
        const heading = headings[headingIndex];
        const top = containerStack[containerStack.length - 1];
        if (top) top.lastHeading = heading.text;
        headingIndex += 1;
      }
    }
    while (headingIndex < headings.length && headings[headingIndex].end <= until) {
      const heading = headings[headingIndex];
      const top = containerStack[containerStack.length - 1];
      if (top) top.lastHeading = heading.text;
      headingIndex += 1;
    }
    let labelText = '';
    for (let depth = containerStack.length - 1; depth >= 0; depth -= 1) {
      if (containerStack[depth].lastHeading) {
        labelText = containerStack[depth].lastHeading;
        break;
      }
    }
    const en = EN_LABEL_RE.test(labelText);
    const ar = AR_LABEL_RE.test(labelText);
    const zh = ZH_LABEL_RE.test(labelText);
    if ((en && ar) || (en && zh) || (ar && zh)) {
      throw extractError('section#s09 内存在同时含多语言标签的 <code>，标签不唯一');
    }
    const language = en ? 'en' : ar ? 'ar' : zh ? 'zh-cn' : '';
    blocks.push({
      language,
      labelText,
      lines: extractLines(match[1]),
    });
    searchFrom = match.index + match[0].length;
  }
  return blocks;
}

function parseDisplayboxChildren(section, openMatch) {
  const containerName = openMatch[1].toLowerCase();
  const tail = section.slice(openMatch.index + openMatch[0].length);
  const children = [];
  let current = null;
  let sawClose = false;
  let searchFrom = 0;
  while (searchFrom < tail.length) {
    const nextTag = tail.indexOf('<', searchFrom);
    if (nextTag < 0) break;
    const text = tail.slice(searchFrom, nextTag);
    if (current) current.raw += text;
    else if (text.trim() !== '') {
      throw extractError('displaybox 容器内存在游离文本（必须恰好 5 个直接子元素）');
    }
    TAG_RE.lastIndex = nextTag;
    const tag = TAG_RE.exec(tail);
    if (!tag) break;
    searchFrom = tag.index + tag[0].length;
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();
    const selfClosing = tag[4] === '/';
    if (closing) {
      if (current) {
        // A closing tag while inside a child belongs to the child (or a nested
        // element of the same name). Only when no child is open can it close
        // the displaybox container itself — otherwise the first child's
        // `</div>` would be mistaken for the outer `</div>`.
        if (name === current.name) {
          if (current.depth > 0) current.depth -= 1;
          else {
            children.push(current);
            current = null;
          }
        }
      } else if (name === containerName) {
        sawClose = true;
        break;
      }
    } else if (!current) {
      current = {name, raw: tag[0], depth: 0};
    } else {
      current.raw += tag[0];
      if (!selfClosing && name === current.name) current.depth += 1;
    }
  }
  if (!sawClose) throw extractError('displaybox 容器缺少闭合标签');
  if (current) throw extractError('displaybox 子元素未闭合');
  if (children.length !== 5) {
    throw extractError(`displaybox 必须恰好包含 5 个直接子元素（实际 ${children.length}）`);
  }
  return children.map(child => {
    const lines = extractLines(child.raw);
    if (lines.length !== 1) {
      throw extractError(`displaybox 每个直接子元素必须恰好一行文本（实际 ${lines.length} 行）`);
    }
    return lines[0];
  });
}

function findUniqueDisplaybox(section) {
  const boxes = [...section.matchAll(DISPLAYBOX_OPEN_RE)];
  if (boxes.length > 1) throw extractError(`section#s09 内 displaybox 出现 ${boxes.length} 次，必须唯一`);
  return boxes.length ? parseDisplayboxChildren(section, boxes[0]) : null;
}

function requireFiveLines(lines, language, label) {
  if (lines.length !== 5) {
    throw extractError(`section#s09 ${label}必须恰好 5 行非空文本（实际 ${lines.length} 行）`);
  }
  return lines;
}

/**
 * Reads the trilingual core selling points from the unique section#s09.
 * Returns {en: {lines}, ar: {lines}, 'zh-cn': {lines}} with byte-exact lines.
 */
export function extractTrilingualCoreSellingPoints(htmlText) {
  const sectionMatch = findUniqueS09Section(htmlText);
  const section = sectionMatch[1];
  const codes = classifyCodeBlocks(section);
  const enCode = codes.filter(block => block.language === 'en');
  const arCode = codes.filter(block => block.language === 'ar');
  const zhCode = codes.filter(block => block.language === 'zh-cn');
  if (enCode.length !== 1 || arCode.length !== 1) {
    throw extractError(`section#s09 内英文/阿文 <code> 必须各恰好一个（en=${enCode.length} ar=${arCode.length}）`);
  }
  const unlabeled = codes.filter(block => !block.language);
  if (unlabeled.length) {
    throw extractError(`section#s09 内存在 ${unlabeled.length} 个无语言标签的 <code>，拒绝猜测语言`);
  }
  const displayboxLines = findUniqueDisplaybox(section);
  let zhLines = null;
  if (displayboxLines !== null) {
    zhLines = displayboxLines;
    if (zhCode.length) {
      if (JSON.stringify(zhCode[0].lines) !== JSON.stringify(zhLines)) {
        throw extractError('section#s09 内中文 displaybox 与中文 <code> 内容不一致');
      }
    }
  } else if (zhCode.length === 1) {
    zhLines = zhCode[0].lines;
  } else {
    throw extractError('section#s09 内缺少中文 displaybox（或唯一中文 <code>）');
  }
  return {
    en: {lines: requireFiveLines(enCode[0].lines, 'en', '英文 code')},
    ar: {lines: requireFiveLines(arCode[0].lines, 'ar', '阿文 code')},
    'zh-cn': {lines: requireFiveLines(zhLines, 'zh-cn', '中文 displaybox')},
  };
}

function materialFromExtraction(extracted, sourceFileSha256, sourceLabel) {
  const rows = {};
  for (const language of ['en', 'ar', 'zh-cn']) {
    rows[language] = {
      language,
      lines: [...extracted[language].lines],
      sha256: sha256Utf8(extracted[language].lines.join('\n')),
    };
  }
  return rows;
}

/**
 * Builds or verifies the strict material JSON against the actual HTML file:
 *  1. sourceFileSha256 must equal the sha256 of the real source file bytes;
 *  2. rows must be extracted from the unique section#s09 (byte-exact);
 *  3. when a material JSON is supplied, every row line must equal the
 *     extracted line byte-for-byte and per-row sha256 must match.
 */
export function verifyDescriptionMaterialAgainstHtml(htmlText, sourceFileBytes, options = {}) {
  const {material = null, sourceFileBasename = '', sourceFileSha256 = ''} = options;
  if (!Buffer.isBuffer(sourceFileBytes) && !(sourceFileBytes instanceof Uint8Array)) {
    throw extractError('source file bytes are required');
  }
  const bytes = Buffer.from(sourceFileBytes);
  const actualSha = crypto.createHash('sha256').update(bytes).digest('hex');
  const materialProvided = Boolean(material && typeof material === 'object' && !Array.isArray(material));
  const declaredSha = String(
    materialProvided ? (sourceFileSha256 || material.sourceFileSha256 || '') : (sourceFileSha256 || ''),
  ).toLowerCase();
  // Source-only construction has no declared SHA to verify; the material is
  // built directly from the actual file bytes. Verification of the declared
  // SHA (and byte-exact rows) applies only when a material JSON is supplied.
  if ((materialProvided && !declaredSha) || (declaredSha && declaredSha !== actualSha)) {
    const error = new Error(
      `sourceFileSha256 与用户提供的实际源文件字节不符：声明=${declaredSha || '(missing)'} 实际=${actualSha}`,
    );
    error.code = 'DESCRIPTION_SOURCE_SHA_MISMATCH';
    throw error;
  }
  const basename = String(sourceFileBasename || '').replace(/\\/g, '/').split('/').pop().trim();
  if (!basename) throw extractError('sourceFileBasename is required and must not be a path');
  const extracted = extractTrilingualCoreSellingPoints(bytes.toString('utf8'));
  const rows = materialFromExtraction(extracted, actualSha, basename);
  if (materialProvided) {
    for (const language of ['en', 'ar', 'zh-cn']) {
      const expected = rows[language].lines;
      const actual = Array.isArray(material.rows?.[language]?.lines) ? material.rows[language].lines : null;
      if (!actual || actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
        const error = new Error(`material rows.${language} 与实际 section#s09 文本逐字不一致；请勿改写审核资料原文`);
        error.code = 'DESCRIPTION_MATERIAL_MISMATCH_SOURCE';
        throw error;
      }
      const declaredRowSha = String(material.rows[language].sha256 || '').toLowerCase();
      if (declaredRowSha && declaredRowSha !== rows[language].sha256) {
        const error = new Error(`material rows.${language}.sha256 与逐字行不符：声明=${declaredRowSha} 实际=${rows[language].sha256}`);
        error.code = 'DESCRIPTION_MATERIAL_SHA_MISMATCH';
        throw error;
      }
    }
  }
  return {
    material: {
      schemaVersion: 1,
      sourceLabel: basename,
      sourceFileSha256: actualSha,
      rows,
    },
    extracted,
  };
}
