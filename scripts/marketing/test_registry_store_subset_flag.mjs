#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A newly enabled store can legitimately have no enrollable ordinary campaign yet: the
// platform returns no eligible entries for it, so the store has zero baseline rows. The
// publish path must stay usable behind one explicit, auditable flag instead of failing the
// whole run, mirroring the enabled-store-subset semantics the guard already relies on.
const cli = read('scripts/marketing/manage_marketing_plan_registry.mjs');
assert.match(cli, /--allow-enabled-store-subset/, 'registry CLI must expose --allow-enabled-store-subset');
assert.match(cli, /allowStoreCoverageSubset: args\.allowEnabledStoreSubset === true/, 'registry CLI must forward the subset flag into publish');

const lib = read('lib/marketing_plan_registry.mjs');
assert.match(lib, /allowStoreCoverageSubset = false,/, 'registry lib must default the subset flag to false');
assert.match(lib, /allowStoreCoverageSubset,/, 'registry lib must forward the subset flag into pair validation');
assert.match(lib, /if \(!allowStoreCoverageSubset && expectedStoreCount/, 'coverage equality must stay gated on the flag');

console.log(JSON.stringify({ok: true, test: 'registry_publish_enabled_store_subset_flag'}));