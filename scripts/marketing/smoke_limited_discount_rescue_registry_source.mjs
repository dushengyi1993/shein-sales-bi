#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';

const file = 'scripts/marketing/apply_hl_limited_discount_rescue.mjs';
const source = fs.readFileSync(file, 'utf8');

const injected = source.match(/const\s*\{([^{}]+)\}\s*=\s*__arg;/)?.[1];
assert.ok(injected, 'browser argument destructuring must be explicit');
const fields = injected.split(',').map(field => field.trim()).filter(Boolean);
assert.ok(fields.includes('replaceActivityIds'));
assert.ok(fields.includes('registrySource'));
assert.ok(fields.includes('pricingRuleHash'));
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
