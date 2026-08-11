#!/usr/bin/env node

// Terminal-state validator for a portal section cache artifact.
//
// The queue worker and prewarm treat a section as successfully refreshed only
// when the HTTP response is a clean 200 AND the underlying artifact is
// terminal: the core (data.json) carries a non-empty generatedAt and the
// section file was generated for exactly that generation. A 202 pending
// response, a stale/failed-refresh header, or a non-terminal artifact is
// never success.
//
// Large sections (profit is ~98MB) are validated with a bounded head read,
// never a full parse. homeProfit is small and derived, so its structure is
// validated by parsing the whole file; profit is validated by confirming the
// dailyStoreProducts array key opens inside the bounded head. Section data is
// never printed: the report contains only metadata and a reason code.

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SECTION_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const DEFAULT_HEAD_BYTES = 64 * 1024;
const MIN_HEAD_BYTES = 4 * 1024;
const MAX_HEAD_BYTES = 1024 * 1024;
const HOME_PROFIT_MAX_SIZE = 64 * 1024 * 1024;

function usage(message = '') {
  if (message) console.error(message);
  console.error(`Usage:
  check_bi_portal_section_terminal.mjs --section NAME [--root DIR] [--head-bytes N]`);
  return 2;
}

function parseArgs(argv) {
  const options = {
    root: path.join(process.cwd(), 'outputs', 'bi-portal'),
    section: '',
    headBytes: DEFAULT_HEAD_BYTES,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new TypeError(`QUEUE_VALUE_MISSING_${token}`);
      return argv[index];
    };
    if (token === '--root') options.root = path.resolve(next());
    else if (token === '--section') options.section = String(next()).trim();
    else if (token === '--head-bytes') options.headBytes = Number(next());
    else throw new TypeError(`QUEUE_ARGUMENT_UNKNOWN_${token}`);
  }
  if (!SECTION_PATTERN.test(options.section)) throw new TypeError(`SECTION_INVALID_${options.section}`);
  if (!Number.isSafeInteger(options.headBytes) || options.headBytes < MIN_HEAD_BYTES || options.headBytes > MAX_HEAD_BYTES) {
    throw new TypeError('HEAD_BYTES_INVALID');
  }
  return options;
}

function extractStringField(text, field) {
  const match = new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`).exec(text);
  return match?.[1] || '';
}

function readHead(file, headBytes) {
  const handle = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(handle);
    const size = Number(stat.size || 0);
    if (size <= 0) return {size: 0, text: ''};
    const length = Math.min(size, headBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(handle, buffer, 0, length, 0);
    return {size, text: buffer.subarray(0, bytesRead).toString('utf8')};
  } finally {
    fs.closeSync(handle);
  }
}

export function validateTerminalArtifact({root, section, headBytes = DEFAULT_HEAD_BYTES} = {}) {
  const normalizedSection = String(section || '').trim();
  if (!SECTION_PATTERN.test(normalizedSection)) {
    return {ok: false, reason: 'section_invalid', section: normalizedSection};
  }
  const coreFile = path.join(root, 'data.json');
  let core;
  try {
    core = JSON.parse(fs.readFileSync(coreFile, 'utf8'));
  } catch {
    return {ok: false, reason: 'core_file_missing', section: normalizedSection};
  }
  const coreGeneratedAt = String(core?.generatedAt || core?.__sections?.generatedAt || '').trim();
  if (!coreGeneratedAt) {
    return {ok: false, reason: 'core_generated_at_missing', section: normalizedSection};
  }

  const sectionFile = path.join(root, 'sections', `${normalizedSection}.json`);
  let head;
  try {
    head = readHead(sectionFile, headBytes);
  } catch {
    return {ok: false, reason: 'section_file_missing', section: normalizedSection, coreGeneratedAt};
  }
  if (head.size <= 0 || !head.text) {
    return {ok: false, reason: 'section_file_empty', section: normalizedSection, coreGeneratedAt};
  }
  if (extractStringField(head.text, 'section') !== normalizedSection) {
    return {ok: false, reason: 'section_name_mismatch', section: normalizedSection, coreGeneratedAt};
  }
  const sectionGeneratedAt = extractStringField(head.text, 'generatedAt');
  if (!sectionGeneratedAt) {
    return {ok: false, reason: 'section_generated_at_missing', section: normalizedSection, coreGeneratedAt};
  }
  if (sectionGeneratedAt !== coreGeneratedAt) {
    return {
      ok: false,
      reason: 'section_generated_at_mismatch',
      section: normalizedSection,
      coreGeneratedAt,
      sectionGeneratedAt,
    };
  }
  if (!/"ok"\s*:\s*true/.test(head.text)) {
    return {ok: false, reason: 'section_not_ok', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
  }
  if (!/"data"\s*:/.test(head.text)) {
    return {ok: false, reason: 'section_data_missing', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
  }

  if (normalizedSection === 'profit') {
    // writeBiSectionCache serializes data before the huge arrays and the
    // generator writes dailyStoreProducts as the first profit key, so a
    // bounded head read proves the array opens. Anything else fails closed.
    if (!/"dailyStoreProducts"\s*:\s*\[/.test(head.text)) {
      return {
        ok: false,
        reason: 'profit_daily_store_products_missing',
        section: normalizedSection,
        coreGeneratedAt,
        sectionGeneratedAt,
      };
    }
  }

  if (normalizedSection === 'homeProfit') {
    // homeProfit is a small derived summary; a full parse is safe and proves
    // the fail-closed source invariants the server enforces.
    if (head.size > HOME_PROFIT_MAX_SIZE) {
      return {ok: false, reason: 'home_profit_unexpected_size', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
    let cached;
    try {
      cached = JSON.parse(fs.readFileSync(sectionFile, 'utf8'));
    } catch {
      return {ok: false, reason: 'section_file_unparseable', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
    const summary = cached?.data?.homeProfitSummary;
    if (!summary || typeof summary !== 'object') {
      return {ok: false, reason: 'home_profit_summary_missing', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
    if (!Array.isArray(summary.dailyScopes)) {
      return {ok: false, reason: 'home_profit_daily_scopes_missing', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
    if (String(summary.sourceGeneratedAt || '') !== coreGeneratedAt) {
      return {ok: false, reason: 'home_profit_source_mismatch', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
    if (Boolean(summary.staleSource)) {
      return {ok: false, reason: 'home_profit_stale_source', section: normalizedSection, coreGeneratedAt, sectionGeneratedAt};
    }
  }

  return {
    ok: true,
    section: normalizedSection,
    coreGeneratedAt,
    sectionGeneratedAt,
    size: head.size,
    headBytes,
  };
}

export function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(JSON.stringify({ok: false, errorCode: String(error?.message || 'QUEUE_ARGUMENT_INVALID')}));
    return usage();
  }
  const result = validateTerminalArtifact(options);
  console.log(JSON.stringify(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
