#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = path.join(ROOT, 'infra', 'warehouse', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const functionMatch = schema.match(/CREATE OR REPLACE FUNCTION dim\.product_match_key[\s\S]*?\$\$;/);
assert.ok(functionMatch, 'dim.product_match_key function exists in schema.sql');

const body = functionMatch[0];
const mappings = [];
const mappingRe = /WHEN\s+key\s+IN\s*\(([^)]+)\)\s+THEN\s+'([^']+)'/g;
for (const match of body.matchAll(mappingRe)) {
  const keys = [...match[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  mappings.push({keys, target: match[2]});
}

function normalizeDbKey(value) {
  const key = String(value || '').replace(/[^A-Za-z0-9]+/g, '').toUpperCase();
  for (const mapping of mappings) {
    if (mapping.keys.includes(key)) return mapping.target;
  }
  return key;
}

const cases = [
  ['S1810电热水壶', 'S1810'],
  ['S1810热水壶', 'S1810'],
  ['BL02热水壶', 'S1810'],
  ['BL02电热水壶', 'S1810'],
  ['BL02', 'S1810'],
  ['GL-BL02', 'S1810'],
  ['2001', '2001'],
];

for (const [input, expected] of cases) {
  assert.equal(normalizeDbKey(input), expected, `${input} product_match_key`);
}

console.log(`product_match_key_schema: ${cases.length} checks passed`);
