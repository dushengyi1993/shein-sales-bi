#!/usr/bin/env node
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(ROOT, 'infra', 'warehouse', 'schema.sql');
const aliasPath = path.join(ROOT, 'config', 'product_aliases.json');
const schema = fs.readFileSync(schemaPath, 'utf8');
const aliasConfig = JSON.parse(fs.readFileSync(aliasPath, 'utf8').replace(/^\uFEFF/, ''));

const functionMatch = schema.match(/CREATE OR REPLACE FUNCTION dim\.product_match_key[\s\S]*?\$\$;/);
assert.ok(functionMatch, 'dim.product_match_key function exists in schema.sql');

const canonicalFunctionMatch = schema.match(/CREATE OR REPLACE FUNCTION dim\.product_canonical_sn[\s\S]*?\$\$;/);
assert.ok(canonicalFunctionMatch, 'dim.product_canonical_sn function exists in schema.sql');

const body = functionMatch[0];
const mappings = [];
const mappingRe = /WHEN\s+key\s+IN\s*\(([^)]+)\)\s+THEN\s+'([^']*)'/g;
for (const match of body.matchAll(mappingRe)) {
  const keys = [...match[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  mappings.push({keys, target: match[2]});
}

const canonicalBody = canonicalFunctionMatch[0];
const canonicalMappings = [];
const canonicalMappingRe = /WHEN\s+'([^']*)'\s+THEN\s+'([^']*)'/g;
for (const match of canonicalBody.matchAll(canonicalMappingRe)) {
  canonicalMappings.push({matchKey: match[1], canonical: match[2]});
}

function normalizeDbKey(value) {
  const key = String(value || '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
  for (const mapping of mappings) {
    if (mapping.keys.includes(key)) return mapping.target;
  }
  return key;
}

function compactDbAliasKey(value) {
  return String(value || '').normalize('NFKC').replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
}

function aliasList(entry) {
  return (entry.aliases || []).map(alias => typeof alias === 'string' ? alias : alias?.value).filter(Boolean);
}

function canonicalDbSn(value) {
  const matchKey = normalizeDbKey(value);
  for (const mapping of canonicalMappings) {
    if (mapping.matchKey === matchKey) return mapping.canonical;
  }
  return String(value || '');
}

const cases = [
  ['S1810电热水壶', 'S1810'],
  ['S1810热水壶', 'S1810'],
  ['BL02热水壶', 'S1810'],
  ['BL02电热水壶', 'S1810'],
  ['BL02', 'S1810'],
  ['GL-BL02', 'S1810'],
  ['2001', '2001'],
  ['SK-7032', 'SKYM7032'],
  ['SK-YM-7032绞肉机', 'SKYM7032'],
  ['WK-1710-4', 'WK17104'],
  ['KJ-102横条三明治机', 'KJ102'],
  ['KJ-102S三明治机', 'KJ102S'],
  ['KJ-102三明治机', 'KJ102'],
  ['SK-1714', 'SK17145'],
  ['1714', 'SK17145'],
  ['HY-808', 'SK11004'],
  ['PA4-6L小冰箱', 'PA46L'],
  ['SK-446切片机', 'SK446'],
  ['SK-3065', 'SKGT3065'],
  ['SK-GT-3065蒸汽熨烫机', 'SKGT3065'],
  ['SK-675', 'SKJFB675B'],
  ['SK-JFB-675B卷发钳和卷发棒', 'SKJFB675B'],
  ['YJ-SK-JFB-675B', 'SKJFB675B'],
  ['SK-13065布衣清洗机', 'SK13065'],
  ['SK-13065吸尘器', 'SK13065'],
  ['DL-SK-13034', 'SK13034'],
  ['T1', 'T1'],
  ['389', 'JD389'],
  ['689', 'JD389'],
  ['MZ689空气炸锅', 'JD389'],
  ['YJ389空气炸锅', 'JD389'],
  ['ZL389空气炸锅', 'JD389'],
  ['KFJ683901', 'SK6863'],
  ['YSJ-053', 'SK7015'],
  ['RW2017F', 'SK1914'],
  ['RW2017F(SK-1914热风梳)', 'SK1914'],
  ['SK-1711手持搅拌器', 'SK17145'],
  ['YJ-SK-6810半自动意式咖啡机', 'SK6810'],
  ['BY506', 'BY506'],
  ['BY506S', 'BY506S'],
  ['RW2007(15061)', 'SK15061'],
  ['EN 62368-1:2014+A11:2017', ''],
  ['093', '093'],
];

for (const [input, expected] of cases) {
  assert.equal(normalizeDbKey(input), expected, `${input} product_match_key`);
}

const canonicalCases = [
  ['SK-7032', 'SK-YM-7032绞肉机'],
  ['SK-YM-7032绞肉机', 'SK-YM-7032绞肉机'],
  ['WK-1710-4', 'WK-1710-4手持搅拌器'],
  ['WK-1710-4手持搅拌器', 'WK-1710-4手持搅拌器'],
  ['KJ-102横条三明治机', 'KJ-102三明治机和早餐机'],
  ['KJ-102三明治机和早餐机', 'KJ-102三明治机和早餐机'],
  ['KJ-102S三明治机', 'KJ-102S三明治机和早餐机'],
  ['KJ-102三明治机', 'KJ-102三明治机和早餐机'],
  ['SK-1714', 'SK-1714-5手持搅拌器'],
  ['1714', 'SK-1714-5手持搅拌器'],
  ['HY-808', 'SK-11004蒸汽熨烫机'],
  ['PA4-6L小冰箱', 'PA4-6L便携式冰箱'],
  ['PA4-6L便携式冰箱', 'PA4-6L便携式冰箱'],
  ['SK-446切片机', 'SK-446电动刀与切片器'],
  ['SK-446电动刀与切片器', 'SK-446电动刀与切片器'],
  ['SK-3065', 'SK-GT-3065蒸汽熨烫机'],
  ['SK-675', 'SK-JFB-675B卷发钳和卷发棒'],
  ['YJ-SK-JFB-675B', 'SK-JFB-675B卷发钳和卷发棒'],
  ['SK-13065布衣清洗机', 'SK-13065吸尘器'],
  ['DL-SK-13034', 'SK-13034杆式吸尘器'],
  ['T1', 'T1激光脱毛仪'],
  ['389', 'JD-389空气炸锅'],
  ['689', 'JD-389空气炸锅'],
  ['MZ689空气炸锅', 'JD-389空气炸锅'],
  ['YJ389空气炸锅', 'JD-389空气炸锅'],
  ['ZL389空气炸锅', 'JD-389空气炸锅'],
  ['KFJ683901', 'SK-6863半自动意式咖啡机'],
  ['YSJ-053', 'SK-7015绞肉机'],
  ['RW2017F', 'SK-1914热风梳'],
  ['RW2017F(SK-1914热风梳)', 'SK-1914热风梳'],
  ['SK-1711手持搅拌器', 'SK-1714-5手持搅拌器'],
  ['YJ-SK-6810半自动意式咖啡机', 'SK-6810半自动意式咖啡机'],
  ['BY506', 'BY-506空气炸锅'],
  ['BY506S', 'BY-506S空气炸锅'],
  ['RW2007(15061)', 'SK-15061热风梳'],
  ['EN 62368-1:2014+A11:2017', ''],
  ['093', '093'],
];

for (const [input, expected] of canonicalCases) {
  assert.equal(canonicalDbSn(input), expected, `${input} product_canonical_sn`);
}

let generatedAliasChecks = 0;
for (const entry of aliasConfig.aliases || []) {
  if (entry.status && entry.status !== 'active') continue;
  const canonicalKey = compactDbAliasKey(entry.canonical);
  if (!canonicalKey) continue;
  for (const alias of [entry.canonical, ...aliasList(entry)]) {
    const aliasKey = compactDbAliasKey(alias);
    if (!aliasKey || !/\d/.test(aliasKey)) continue;
    assert.equal(normalizeDbKey(alias), canonicalKey, `${alias} config alias must match schema product_match_key`);
    assert.equal(canonicalDbSn(alias), entry.canonical, `${alias} config alias must match schema product_canonical_sn`);
    generatedAliasChecks++;
  }
}

const storageViewMatch = schema.match(/CREATE OR REPLACE VIEW mart\.storage_fee_product_daily AS[\s\S]*?CREATE OR REPLACE VIEW mart\.storage_fee_product_store_daily AS/);
assert.ok(storageViewMatch, 'mart.storage_fee_product_daily view exists in schema.sql');
const storageView = storageViewMatch[0];
assert.match(
  storageView,
  /coalesce\(dim\.product_match_key\(d\.standard_goods_sn\),\s*dim\.product_match_key\(d\.storage_code\),\s*nullif\(d\.match_key,''\)\)/,
  'ET storage detail must recompute match_key from standard_goods_sn before using stale stored match_key',
);
assert.match(
  storageView,
  /coalesce\(dim\.product_match_key\(standard_goods_sn\),\s*nullif\(match_key,''\)\) AS match_key/,
  'ET box item expansion must recompute match_key from standard_goods_sn before using stale stored match_key',
);

const eolRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shein-schema-eol-'));
try {
  const crlfSchemaPath = path.join(eolRoot, 'schema.sql');
  const aliasCopyPath = path.join(eolRoot, 'product_aliases.json');
  fs.writeFileSync(crlfSchemaPath, schema.replace(/\r?\n/g, '\r\n'));
  fs.copyFileSync(aliasPath, aliasCopyPath);
  const env = {
    ...process.env,
    SHEIN_PRODUCT_ALIAS_CONFIG_PATH: aliasCopyPath,
    SHEIN_WAREHOUSE_SCHEMA_PATH: crlfSchemaPath,
  };
  const check = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'generate_product_match_key_schema.mjs'), '--check', '--quiet'], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
  assert.equal(check.status, 0, `CRLF schema must be considered in sync: ${check.stderr || check.stdout}`);
  const after = fs.readFileSync(crlfSchemaPath);
  const lfCount = [...after].filter((byte, index) => byte === 10 && after[index - 1] !== 13).length;
  assert.equal(lfCount, 0, 'schema generator must preserve CRLF throughout a CRLF file');
} finally {
  fs.rmSync(eolRoot, {recursive: true, force: true});
}

console.log(`product_match_key_schema: ${cases.length} match-key checks, ${canonicalCases.length} canonical checks, ${generatedAliasChecks} generated alias checks, ET storage precedence, and cross-platform EOL checks passed`);
