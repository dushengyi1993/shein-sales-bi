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
 * Phase B also supports the legacy unique `<section id="s9">` whose
 * trilingual 核心卖点 is exactly three <code> blocks (en/ar/zh-cn). The
 * legacy mapping is deterministic: each code inherits its language from the
 * nearest preceding heading / adjacent label (label-only text runs), or from
 * an explicit three-language order statement (direction). Any ambiguity
 * (duplicate/conflicting/missing labels, extra codes, conflicting order
 * statements) rejects the whole HTML.
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

// Legacy section#s9 helpers: exactly three <code> blocks must map uniquely to
// en/ar/zh-cn. Labels are matched per family; a label text run may contain
// only one language keyword plus separators, otherwise it is not a label.
const LEGACY_LABEL_FAMILIES = Object.freeze([
  {language: 'en', re: /(?:英文|英语|English|\bEN\b)/gi},
  {language: 'ar', re: /(?:阿文|阿拉伯|العربية|Arabic|\bAR\b)/gi},
  {language: 'zh-cn', re: /(?:中文|汉语|Chinese|\bZH\b)/gi},
]);
const LEGACY_KEYWORD_LANGUAGE = new Map([
  ['英文', 'en'], ['英语', 'en'], ['english', 'en'], ['en', 'en'],
  ['阿文', 'ar'], ['阿拉伯', 'ar'], ['العربية', 'ar'], ['arabic', 'ar'], ['ar', 'ar'],
  ['中文', 'zh-cn'], ['汉语', 'zh-cn'], ['chinese', 'zh-cn'], ['zh', 'zh-cn'],
]);
// Order statements must be one contiguous run of exactly three language
// keywords from the same keyword family, separated only by punctuation.
const LEGACY_ORDER_FAMILIES = Object.freeze([
  {family: 'zh', re: /(?:英文|英语|阿文|阿拉伯|中文|汉语)/g},
  {family: 'en', re: /(?:English|Arabic|Chinese)/g},
  {family: 'lat', re: /\b(?:EN|AR|ZH)\b/g},
]);
const LEGACY_LABEL_SEPARATOR_RE = /[\s\u3000，、,，/、|、/、·、：:、（）()、\-、_、—、–、.、。、;；、"“”'‘’]+/g;

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

function findUniqueSectionById(htmlText, sectionId) {
  const idRe = new RegExp(
    `<section\\b[^>]*\\bid\\s*=\\s*["']${String(sectionId)}["'][^>]*>([\\s\\S]*?)<\\/section>`,
    'gi',
  );
  const matches = [...String(htmlText ?? '').matchAll(idRe)];
  if (!matches.length) {
    throw extractError(`HTML 中没有找到唯一的 <section id="${sectionId}"> 三语核心卖点章节`);
  }
  if (matches.length > 1) {
    throw extractError(`HTML 中 section#${sectionId} 出现 ${matches.length} 次，必须唯一`);
  }
  return matches[0];
}

function findUniqueS09Section(htmlText) {
  return findUniqueSectionById(htmlText, 's09');
}

function countSectionMatches(htmlText, sectionId) {
  const idRe = new RegExp(
    `<section\\b[^>]*\\bid\\s*=\\s*["']${String(sectionId)}["'][^>]*>`,
    'gi',
  );
  return [...String(htmlText ?? '').matchAll(idRe)].length;
}

function classifyCodeBlocks(section, sectionLabel = 'section#s09') {
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
      throw extractError(`${sectionLabel} 内存在同时含多语言标签的 <code>，标签不唯一`);
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

function parseDisplayboxChildren(section, openMatch, sectionLabel = 'section#s09') {
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
      throw extractError(`${sectionLabel} displaybox 容器内存在游离文本（必须恰好 5 个直接子元素）`);
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
  if (!sawClose) throw extractError(`${sectionLabel} displaybox 容器缺少闭合标签`);
  if (current) throw extractError(`${sectionLabel} displaybox 子元素未闭合`);
  if (children.length !== 5) {
    throw extractError(`${sectionLabel} displaybox 必须恰好包含 5 个直接子元素（实际 ${children.length}）`);
  }
  return children.map(child => {
    const lines = extractLines(child.raw);
    if (lines.length !== 1) {
      throw extractError(`${sectionLabel} displaybox 每个直接子元素必须恰好一行文本（实际 ${lines.length} 行）`);
    }
    return lines[0];
  });
}

function findUniqueDisplaybox(section, sectionLabel = 'section#s09') {
  const boxes = [...section.matchAll(DISPLAYBOX_OPEN_RE)];
  if (boxes.length > 1) throw extractError(`${sectionLabel} 内 displaybox 出现 ${boxes.length} 次，必须唯一`);
  return boxes.length ? parseDisplayboxChildren(section, boxes[0], sectionLabel) : null;
}

function requireFiveLines(lines, language, label, sectionLabel = 'section#s09') {
  if (lines.length !== 5) {
    throw extractError(`${sectionLabel} ${label}必须恰好 5 行非空文本（实际 ${lines.length} 行）`);
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

// ---------------------------------------------------------------------------
// Legacy section#s9: exactly three <code> blocks mapped uniquely to
// en/ar/zh-cn by adjacency (nearest heading / adjacent label), language
// labels (label-only text runs) and direction (explicit three-language order
// statement). Any ambiguity rejects the whole HTML.
// ---------------------------------------------------------------------------

function legacyOrderStatement(text) {
  const normalized = decodeEntities(stripTagsAndNormalizeBreaks(String(text || '')))
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  for (const family of LEGACY_ORDER_FAMILIES) {
    const matches = [...normalized.matchAll(family.re)];
    if (matches.length !== 3) continue;
    const languages = matches.map(match => LEGACY_KEYWORD_LANGUAGE.get(String(match[0]).toLowerCase()) || '');
    if (languages.some(language => !language)) continue;
    const unique = [...new Set(languages)];
    if (unique.length !== 3) continue;
    const first = matches[0].index;
    const last = matches[matches.length - 1].index + matches[matches.length - 1][0].length;
    const run = normalized.slice(first, last);
    const withoutKeywords = run.replace(family.re, '');
    if (withoutKeywords.replace(LEGACY_LABEL_SEPARATOR_RE, '') !== '') continue;
    return {order: languages, text: normalized};
  }
  return null;
}

function legacyLabelFromText(text) {
  // A label text run may contain exactly one language keyword; any extra
  // content means it is not a label (no guessing).
  const normalized = decodeEntities(stripTagsAndNormalizeBreaks(String(text || '')))
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return {language: '', reject: ''};
  const stripped = normalized.replace(LEGACY_LABEL_SEPARATOR_RE, '');
  const hits = [];
  for (const family of LEGACY_LABEL_FAMILIES) {
    for (const match of normalized.matchAll(family.re)) {
      hits.push({language: family.language, keyword: String(match[0]).toLowerCase()});
    }
  }
  if (!hits.length) return {language: '', reject: ''};
  const joined = hits.map(hit => hit.keyword).join('');
  if (stripped.toLowerCase() !== joined) return {language: '', reject: ''};
  const languages = [...new Set(hits.map(hit => hit.language))];
  if (languages.length !== 1) {
    return {language: '', reject: `同时命中多语言标签 ${languages.join('/')}`};
  }
  return {language: languages[0], reject: ''};
}

function legacyLanguageFromPreDirection(section, codeMatch) {
  const before = section.slice(0, codeMatch.index);
  const open = before.match(/<pre\b([^>]*)>\s*$/i);
  if (!open) return {language: '', evidence: ''};
  const after = section.slice(codeMatch.index + codeMatch[0].length);
  if (!/^\s*<\/pre\s*>/i.test(after)) return {language: '', evidence: ''};
  const dirMatch = String(open[1] || '').match(/\bdir\s*=\s*["'](ltr|rtl)["']/i);
  if (!dirMatch) return {language: '', evidence: ''};
  const text = extractLines(codeMatch[1]).join('\n');
  const hasArabic = /[\u0600-\u06ff]/u.test(text);
  const hasCjk = /[\u3400-\u9fff]/u.test(text);
  if (hasArabic && hasCjk) {
    throw extractError('section#s9 的 pre/code 同时包含阿文与中文脚本，方向证据冲突');
  }
  const dir = dirMatch[1].toLowerCase();
  if (dir === 'rtl') {
    if (!hasArabic || hasCjk) throw extractError('section#s9 的 dir=rtl code 未提供唯一阿文脚本证据');
    return {language: 'ar', evidence: 'pre_dir_rtl+arabic_script'};
  }
  if (hasArabic) throw extractError('section#s9 的 dir=ltr code 含阿文脚本，方向证据冲突');
  return hasCjk
    ? {language: 'zh-cn', evidence: 'pre_dir_ltr+cjk_script'}
    : {language: 'en', evidence: 'pre_dir_ltr+non_arabic_non_cjk_script'};
}

function assignLegacyLanguages(blocks, directionOrder) {
  const counts = {};
  for (const block of blocks) {
    if (block.language) counts[block.language] = (counts[block.language] || 0) + 1;
  }
  const duplicates = Object.entries(counts).filter(([, count]) => count > 1).map(([language]) => language);
  if (duplicates.length) {
    throw extractError(`section#s9 语言标签重复：${duplicates.join('/')}，必须唯一`);
  }
  const unlabeled = blocks.filter(block => !block.language);
  if (!unlabeled.length) {
    const missing = ['en', 'ar', 'zh-cn'].filter(language => !counts[language]);
    if (!missing.length) return blocks.map(block => block.language);
    throw extractError(`section#s9 三个 <code> 标签不构成完整 en/ar/zh-cn（缺少 ${missing.join('/')}）`);
  }
  if (!directionOrder) {
    throw extractError(`section#s9 存在 ${unlabeled.length} 个无语言标签的 <code> 且无显式三语顺序声明，拒绝猜测语言`);
  }
  for (const [index, block] of blocks.entries()) {
    if (block.language && directionOrder[index] !== block.language) {
      throw extractError(`section#s9 第 ${index + 1} 个 <code> 标签(${block.language})与声明顺序(${directionOrder[index]})冲突`);
    }
  }
  const assigned = blocks.map((block, index) => block.language || directionOrder[index]);
  const complete = ['en', 'ar', 'zh-cn'].every(language => assigned.includes(language));
  if (!complete) {
    throw extractError('section#s9 方向声明无法与三语标签唯一映射，拒绝');
  }
  return assigned;
}

function classifyLegacyCodeBlocks(section) {
  const codes = [...section.matchAll(CODE_RE)];
  if (codes.length !== 3) {
    throw extractError(`section#s9 内 <code> 必须恰好 3 个（实际 ${codes.length} 个），拒绝猜测语言`);
  }
  if (DISPLAYBOX_OPEN_RE.test(section)) {
    throw extractError('section#s9 不允许出现 displaybox 结构；旧版三语核心卖点只接受恰好 3 个 <code>');
  }
  const headings = [...section.matchAll(HEADING_RE)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: decodeEntities(stripTagsAndNormalizeBreaks(match[2])).replace(/\s+/g, ' ').trim(),
  }));
  const orders = [];
  const preamble = section.slice(0, codes[0].index);
  const preambleOrder = legacyOrderStatement(preamble);
  if (preambleOrder) orders.push(preambleOrder);
  for (const heading of headings) {
    const order = legacyOrderStatement(heading.text);
    if (order) orders.push(order);
  }
  const distinctOrders = [...new Set(orders.map(order => order.order.join('/')))];
  if (distinctOrders.length > 1) {
    throw extractError(`section#s9 出现多个不同的三语顺序声明（${distinctOrders.join(' / ')}），方向不唯一`);
  }
  const directionOrder = orders.length ? orders[0].order : null;
  const blocks = [];
  for (const [index, match] of codes.entries()) {
    const slotStart = index === 0 ? 0 : codes[index - 1].index + codes[index - 1][0].length;
    const slotText = section.slice(slotStart, match.index);
    const inline = legacyLabelFromText(slotText);
    if (inline.reject) {
      throw extractError(`section#s9 第 ${index + 1} 个 <code> 相邻标签存在歧义：${inline.reject}`);
    }
    let headingLabel = '';
    const slotHeadings = headings.filter(heading => heading.end <= match.index && heading.start >= slotStart);
    const nearestHeading = slotHeadings.length ? slotHeadings[slotHeadings.length - 1] : null;
    if (nearestHeading && !legacyOrderStatement(nearestHeading.text)) {
      const heading = legacyLabelFromText(nearestHeading.text);
      if (heading.reject) {
        throw extractError(`section#s9 第 ${index + 1} 个 <code> 最近标题存在歧义：${heading.reject}`);
      }
      headingLabel = heading.language;
    }
    if (inline.language && headingLabel && inline.language !== headingLabel) {
      throw extractError(`section#s9 第 ${index + 1} 个 <code> 相邻标签(${inline.language})与最近标题(${headingLabel})不一致，拒绝猜测`);
    }
    const preDirection = legacyLanguageFromPreDirection(section, match);
    const labeledLanguage = headingLabel || inline.language;
    if (labeledLanguage && preDirection.language && labeledLanguage !== preDirection.language) {
      throw extractError(`section#s9 第 ${index + 1} 个 <code> 标签(${labeledLanguage})与 pre 方向/字符脚本证据(${preDirection.language})冲突`);
    }
    blocks.push({
      language: labeledLanguage || preDirection.language,
      directionEvidence: preDirection.evidence,
      lines: extractLines(match[1]),
    });
  }
  const assigned = assignLegacyLanguages(blocks, directionOrder);
  return blocks.map((block, index) => ({...block, language: assigned[index]}));
}

/**
 * Legacy unique section#s9: exactly three <code> blocks mapped uniquely to
 * en/ar/zh-cn (adjacency / direction / language labels), 5 lines each.
 */
export function extractLegacyTrilingualCoreSellingPoints(htmlText) {
  const sectionMatch = findUniqueSectionById(htmlText, 's9');
  const blocks = classifyLegacyCodeBlocks(sectionMatch[1]);
  const byLanguage = {};
  for (const block of blocks) {
    byLanguage[block.language] = requireFiveLines(block.lines, block.language, `${block.language} code`, 'section#s9');
  }
  return {
    en: {lines: byLanguage.en},
    ar: {lines: byLanguage.ar},
    'zh-cn': {lines: byLanguage['zh-cn']},
  };
}

/**
 * Auto section detection for Phase B backfill: exactly one of section#s09 /
 * section#s9 must exist; both present is ambiguous and rejected.
 */
export function extractTrilingualCoreSellingPointsAuto(htmlText) {
  const s09Count = countSectionMatches(htmlText, 's09');
  const s9Count = countSectionMatches(htmlText, 's9');
  if (s09Count && s9Count) {
    throw extractError(`HTML 同时包含 section#s09(${s09Count} 个)与 section#s9(${s9Count} 个)，无法确定唯一审核版本，拒绝`);
  }
  if (s9Count) return {sectionUsed: 's9', extracted: extractLegacyTrilingualCoreSellingPoints(htmlText)};
  if (s09Count) return {sectionUsed: 's09', extracted: extractTrilingualCoreSellingPoints(htmlText)};
  throw extractError('HTML 中既没有唯一 section#s09 也没有唯一 section#s9 三语核心卖点章节');
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
 *  2. rows must be extracted from the unique section#s09 (or legacy
 *     section#s9 when `section: 's9'`/`'auto'` is requested) byte-exact;
 *  3. when a material JSON is supplied, every row line must equal the
 *     extracted line byte-for-byte and per-row sha256 must match.
 */
export function verifyDescriptionMaterialAgainstHtml(htmlText, sourceFileBytes, options = {}) {
  const {material = null, sourceFileBasename = '', sourceFileSha256 = '', section = 's09'} = options;
  const sectionMode = String(section || 's09').trim().toLowerCase();
  if (!['s09', 's9', 'auto'].includes(sectionMode)) {
    throw extractError(`section 选项必须是 s09/s9/auto（当前 ${sectionMode || '(missing)'}）`);
  }
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
  const html = bytes.toString('utf8');
  let extracted;
  let sectionUsed;
  if (sectionMode === 's9') {
    sectionUsed = 's9';
    extracted = extractLegacyTrilingualCoreSellingPoints(html);
  } else if (sectionMode === 'auto') {
    const auto = extractTrilingualCoreSellingPointsAuto(html);
    sectionUsed = auto.sectionUsed;
    extracted = auto.extracted;
  } else {
    sectionUsed = 's09';
    extracted = extractTrilingualCoreSellingPoints(html);
  }
  const rows = materialFromExtraction(extracted, actualSha, basename);
  if (materialProvided) {
    for (const language of ['en', 'ar', 'zh-cn']) {
      const expected = rows[language].lines;
      const actual = Array.isArray(material.rows?.[language]?.lines) ? material.rows[language].lines : null;
      if (!actual || actual.length !== expected.length || actual.some((line, index) => line !== expected[index])) {
        const error = new Error(`material rows.${language} 与实际 section#${sectionUsed} 文本逐字不一致；请勿改写审核资料原文`);
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
    sectionUsed,
  };
}
