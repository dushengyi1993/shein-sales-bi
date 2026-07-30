#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = 'scripts/marketing/apply_hl_limited_discount_rescue.mjs';
const source = fs.readFileSync(file, 'utf8');

assert.match(source, /replaceActivityIds,\s+registrySource,\s+}\s*=\s*__arg;/);
assert.match(source, /manualSpecialProtection\s*=\s*{\s+registrySource,/);
assert.match(source, /registrySource:\s*manualRegistry\.sourcePath,/);
assert.doesNotMatch(
  source,
  /manualSpecialProtection\s*=\s*{\s+registrySource:\s*manualRegistry\.sourcePath,/,
);

console.log(JSON.stringify({
  ok: true,
  test: 'limited_discount_rescue_registry_source_is_explicitly_injected',
}));
