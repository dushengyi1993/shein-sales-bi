#!/usr/bin/env node
// A helper defined inside another function's body is invisible to its caller and
// fails only at runtime, in production, on the first store that reaches it:
// 2026-09-19 the platform-refusal helper was inserted inside
// transactionPreflightPartition, so processStore threw
// `platformRefusedSkcs is not defined` and two stores (XL, YJ) failed after a
// successful write. String assertions cannot catch that, so this test appends a
// runtime probe to the module and imports it: `typeof` evaluated at module scope
// proves whether the declaration is actually reachable from processStore.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const moduleUrl = new URL('../scripts/marketing/batch_apply_new_listing_limited_discount.mjs', import.meta.url);
const moduleFile = fileURLToPath(moduleUrl);
const source = await fs.readFile(moduleFile, 'utf8');
const checks = [];

const probes = ['platformRefusedSkcs', 'classifyBlockedDryRun', 'transactionPreflightPartition', 'processStore'];
const probeSource = `${source}\n\nexport const __scopeProbe = {${probes.map(name => `${JSON.stringify(name)}: typeof ${name}`).join(', ')}};\n`;

// The probe must sit next to the real module so its relative imports resolve.
const probeFile = path.join(path.dirname(moduleFile), `.scope-probe-${process.pid}.mjs`);
try {
  await fs.writeFile(probeFile, probeSource, 'utf8');
  let probe;
  try {
    probe = (await import(pathToFileURL(probeFile).href)).__scopeProbe;
  } finally {
    await fs.rm(probeFile, {force: true});
  }

  for (const name of probes) {
    assert.equal(probe[name], 'function',
      `${name} must be resolvable from module scope; got ${probe[name]} (a declaration nested in another function is invisible to its caller)`);
  }
  checks.push('helpers_resolvable_at_module_scope');

  const module = await import(moduleUrl.href);
  assert.equal(typeof module.processStore, 'function', 'processStore must remain exported');
  assert.equal(typeof module.transactionPreflightPartition, 'function', 'transactionPreflightPartition must remain exported');
  checks.push('entrypoints_still_exported');

  // The probe file must not be left behind in the repository.
  const leftovers = (await fs.readdir(path.dirname(moduleFile))).filter(name => name.startsWith('.scope-probe-'));
  assert.deepEqual(leftovers, [], 'the temporary probe must be removed');
  checks.push('probe_cleanup_ok');

  console.log(JSON.stringify({ok: true, test: 'marketing_fallback_helper_scope_contract', checks}));
} finally {
  await fs.rm(probeFile, {force: true});
}

