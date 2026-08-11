#!/usr/bin/env node
/**
 * Read-only completion gate for the actual SK-11004 reviewed HTML.
 *
 * Usage:
 *   node scripts/test_link_ops_extract_sk11004.mjs \
 *     --html <SK-11004 审核资料.html> \
 *     --expected-source-sha <sha256> --expected-sha-ar <sha256> --expected-sha-en <sha256> --expected-sha-zh <sha256>
 *   (or --material-json <已核验material.json> to verify declared rows/SHAs)
 *
 * It extracts EN/AR code lines and the Chinese displaybox lines from the
 * unique section#s09, requires exactly 5 lines per language, and requires the
 * three known per-language SHA256 values to match exactly. Output carries
 * hashes/counts only — never full text. Exit code 0 means the actual file
 * matches the known reviewed-material hashes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {verifyDescriptionMaterialAgainstHtml, extractTrilingualCoreSellingPoints} from '../lib/link_ops_description_material_extract.mjs';

const KNOWN = Object.freeze({
  source: '08fc51ba7cc5b5133b45304d85891aaaf4f6d9f20102718f38118e0ecb032f2d',
  ar: '6be71086f98fface5fb5798d95f460fc1ffb5da6b2fcb64aa3970ba50041671d',
  en: '7125380ec95b09276bb66a69bda5331d5226a61810c485950722b8fc61e145d6',
  zh: '626bae3b14556f67ecf781f5b5a27ad801e6298bb2d42f3c77e6ef1d72ecb11f',
});

function parseArgs(argv) {
  const args = {
    htmlFile: process.env.SHEIN_SK11004_REVIEWED_HTML ? path.resolve(process.env.SHEIN_SK11004_REVIEWED_HTML) : '',
    materialJsonFile: '',
    expectedSourceSha: KNOWN.source,
    expectedShaAr: KNOWN.ar,
    expectedShaEn: KNOWN.en,
    expectedShaZh: KNOWN.zh,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--html') args.htmlFile = path.resolve(String(argv[++i] || '').trim());
    else if (a === '--material-json') args.materialJsonFile = path.resolve(String(argv[++i] || '').trim());
    else if (a === '--expected-source-sha') args.expectedSourceSha = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--expected-sha-ar') args.expectedShaAr = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--expected-sha-en') args.expectedShaEn = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--expected-sha-zh') args.expectedShaZh = String(argv[++i] || '').trim().toLowerCase();
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/test_link_ops_extract_sk11004.mjs --html <file> [--expected-source-sha <sha>] [--material-json <file> | --expected-sha-ar <sha> --expected-sha-en <sha> --expected-sha-zh <sha>]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.htmlFile) return null;
  if (!/^[a-f0-9]{64}$/.test(args.expectedSourceSha)) throw new Error('--expected-source-sha must be a 64-char sha256');
  if (!args.materialJsonFile && (!args.expectedShaAr || !args.expectedShaEn || !args.expectedShaZh)) {
    throw new Error('provide --material-json or all three --expected-sha-* values');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: 'Set SHEIN_SK11004_REVIEWED_HTML or pass --html to run the locked actual-source gate.',
    expected: KNOWN,
  }));
  process.exit(0);
}
const sourceBytes = await fs.readFile(args.htmlFile);
const htmlText = sourceBytes.toString('utf8');
let material = null;
if (args.materialJsonFile) {
  material = JSON.parse(await fs.readFile(args.materialJsonFile, 'utf8'));
}
const verified = verifyDescriptionMaterialAgainstHtml(htmlText, sourceBytes, {
  material,
  sourceFileBasename: path.basename(args.htmlFile),
  sourceFileSha256: material?.sourceFileSha256 || '',
});
const extracted = extractTrilingualCoreSellingPoints(htmlText);
const report = {
  ok: true,
  sourceFile: path.basename(args.htmlFile),
  sourceFileSha256: verified.material.sourceFileSha256,
  languages: {
    en: {lineCount: extracted.en.lines.length, sha256: verified.material.rows.en.sha256},
    ar: {lineCount: extracted.ar.lines.length, sha256: verified.material.rows.ar.sha256},
    'zh-cn': {lineCount: extracted['zh-cn'].lines.length, sha256: verified.material.rows['zh-cn'].sha256},
  },
};
const expected = args.materialJsonFile
  ? {
      source: args.expectedSourceSha,
      ar: String(material.rows.ar.sha256 || '').toLowerCase(),
      en: String(material.rows.en.sha256 || '').toLowerCase(),
      zh: String(material.rows['zh-cn'].sha256 || '').toLowerCase(),
    }
  : {source: args.expectedSourceSha, ar: args.expectedShaAr, en: args.expectedShaEn, zh: args.expectedShaZh};
const failures = [];
if (extracted.en.lines.length !== 5 || extracted.ar.lines.length !== 5 || extracted['zh-cn'].lines.length !== 5) {
  failures.push('line counts must be exactly 5 per language');
}
if (report.sourceFileSha256 !== expected.source) failures.push(`source sha mismatch: expected=${expected.source} actual=${report.sourceFileSha256}`);
if (report.languages.en.sha256 !== expected.en) failures.push(`en sha mismatch: expected=${expected.en} actual=${report.languages.en.sha256}`);
if (report.languages.ar.sha256 !== expected.ar) failures.push(`ar sha mismatch: expected=${expected.ar} actual=${report.languages.ar.sha256}`);
if (report.languages['zh-cn'].sha256 !== expected.zh) failures.push(`zh sha mismatch: expected=${expected.zh} actual=${report.languages['zh-cn'].sha256}`);
report.ok = failures.length === 0;
report.expected = expected;
report.failures = failures;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
