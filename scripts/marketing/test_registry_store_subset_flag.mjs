#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A newly enabled store can legitimately have no enrollable ordinary campaign yet: the
// platform returns no eligible entries for it, so it contributes zero baseline rows. That
// must stay publishable behind one explicit, auditable flag - and the flag has to mean the
// same thing in every coverage check the publish path performs, not just the first one.
const cli = read('scripts/marketing/manage_marketing_plan_registry.mjs');
assert.ok(cli.includes('--allow-enabled-store-subset'), 'registry CLI exposes --allow-enabled-store-subset');
assert.ok(cli.includes('allowStoreCoverageSubset: args.allowEnabledStoreSubset === true'), 'registry CLI forwards the subset flag');

const lib = read('lib/marketing_plan_registry.mjs');
assert.ok(lib.includes('allowStoreCoverageSubset = false,'), 'registry lib defaults the subset flag to false');
assert.ok(lib.includes('allowEnabledStoreSubset: allowStoreCoverageSubset,'), 'candidate readback honours the same subset allowance as the pair check');
assert.ok(lib.includes('if (!allowStoreCoverageSubset && expectedStoreCount'), 'coverage equality stays gated on the flag');

// Real enrollment arrives in ordered waves (base -> exec -> run -> run2, then supplements and
// re-reports). A later manifest supersedes an earlier row; treating that as a hard duplicate
// error forced operators to hand-derive a pruned partition before anything could be published.
const promoter = read('scripts/marketing/promote_composite_ordinary_campaign_baseline.mjs');
assert.ok(promoter.includes('function resolveApprovedUnion('), 'approval waves resolve in manifest order');
assert.ok(!promoter.includes('Duplicate ${label} row across approval manifests'), 'supersession is no longer a hard duplicate error');
assert.ok(promoter.includes('--allow-enabled-store-subset'), 'composite promoter exposes the subset flag');
assert.ok(promoter.includes('allowStoreCoverageSubset: args.allowEnabledStoreSubset === true'), 'composite promoter forwards the subset flag');

console.log(JSON.stringify({ok: true, test: 'registry_publish_enabled_store_subset_and_superseding_approvals'}));