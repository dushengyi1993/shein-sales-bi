#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALIAS_PATH = path.join(ROOT, 'config', 'product_aliases.json');
const SCHEMA_PATH = path.join(ROOT, 'infra', 'warehouse', 'schema.sql');

const args = new Set(process.argv.slice(2));

function compact(value) {
  return String(value || '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function aliasValues(entry) {
  return (entry.aliases || []).map(alias => typeof alias === 'string' ? alias : alias?.value).filter(Boolean);
}

function buildMaps() {
  const cfg = JSON.parse(fs.readFileSync(ALIAS_PATH, 'utf8').replace(/^\uFEFF/, ''));
  const aliasToCanonicalKey = new Map();
  const canonicalKeyToSn = new Map();
  const conflicts = [];

  for (const entry of cfg.aliases || []) {
    if (entry.status && entry.status !== 'active') continue;
    const canonical = String(entry.canonical || '').trim();
    const canonicalKey = compact(canonical);
    if (!canonical || !canonicalKey) continue;
    const previousCanonical = canonicalKeyToSn.get(canonicalKey);
    if (previousCanonical && previousCanonical !== canonical) {
      conflicts.push({type: 'canonical_key', key: canonicalKey, a: previousCanonical, b: canonical});
    }
    canonicalKeyToSn.set(canonicalKey, canonical);

    for (const alias of [canonical, ...aliasValues(entry)]) {
      const aliasKey = compact(alias);
      if (!aliasKey) continue;
      // DB normalization intentionally has only one text argument and strips
      // Chinese descriptors. Aliases like “MZ杆式吸尘器” collapse to “MZ”,
      // which is unsafe without the product title context used by the JS
      // normalizer. Keep only model-like keys that contain digits.
      if (!/\d/.test(aliasKey)) continue;
      const previous = aliasToCanonicalKey.get(aliasKey);
      if (previous && previous !== canonicalKey) {
        conflicts.push({type: 'alias_key', key: aliasKey, a: previous, b: canonicalKey, alias, canonical});
      }
      aliasToCanonicalKey.set(aliasKey, canonicalKey);
    }
  }

  if (conflicts.length) {
    console.error(JSON.stringify({error: 'product alias compact-key conflicts', conflicts}, null, 2));
    process.exit(2);
  }
  return {aliasToCanonicalKey, canonicalKeyToSn};
}

function renderProductMatchKeyFunction(aliasToCanonicalKey) {
  const groups = new Map();
  for (const [aliasKey, canonicalKey] of aliasToCanonicalKey.entries()) {
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, []);
    groups.get(canonicalKey).push(aliasKey);
  }
  const lines = [];
  for (const [canonicalKey, keys] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const uniqKeys = [...new Set(keys)].sort();
    lines.push(`    WHEN key IN (${uniqKeys.map(sqlString).join(', ')}) THEN ${sqlString(canonicalKey)}`);
  }
  return `CREATE OR REPLACE FUNCTION dim.product_match_key(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  WITH k AS (
    SELECT upper(regexp_replace(coalesce(value,''), '[^A-Za-z0-9]+', '', 'g')) AS key
  )
  SELECT CASE
${lines.join('\n')}
    ELSE key
  END
  FROM k;
$$;`;
}

function renderProductCanonicalFunction(canonicalKeyToSn) {
  const lines = [];
  for (const [canonicalKey, canonical] of [...canonicalKeyToSn.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`    WHEN ${sqlString(canonicalKey)} THEN ${sqlString(canonical)}`);
  }
  return `CREATE OR REPLACE FUNCTION dim.product_canonical_sn(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE dim.product_match_key(value)
${lines.join('\n')}
    ELSE coalesce(value,'')
  END;
$$;`;
}

function renderFunctions() {
  const {aliasToCanonicalKey, canonicalKeyToSn} = buildMaps();
  return {
    sql: `${renderProductMatchKeyFunction(aliasToCanonicalKey)}\n\n${renderProductCanonicalFunction(canonicalKeyToSn)}`,
    aliasCount: aliasToCanonicalKey.size,
    canonicalCount: canonicalKeyToSn.size,
  };
}

function writeSchema(rendered) {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const functionBlockRe = /CREATE OR REPLACE FUNCTION dim\.product_match_key\(value text\)[\s\S]*?CREATE OR REPLACE FUNCTION dim\.product_canonical_sn\(value text\)[\s\S]*?\$+;/;
  if (!functionBlockRe.test(schema)) {
    throw new Error('failed to locate product_match_key/product_canonical_sn function block in schema.sql');
  }
  const next = schema.replace(functionBlockRe, () => rendered.sql);
  fs.writeFileSync(SCHEMA_PATH, next);
}

const rendered = renderFunctions();
if (args.has('--write')) {
  writeSchema(rendered);
}

if (!args.has('--quiet')) {
  console.log(JSON.stringify({
    schemaPath: path.relative(ROOT, SCHEMA_PATH),
    aliasPath: path.relative(ROOT, ALIAS_PATH),
    aliasCount: rendered.aliasCount,
    canonicalCount: rendered.canonicalCount,
    wrote: args.has('--write'),
  }, null, 2));
}

export {compact, renderFunctions};
