#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const guard = fs.readFileSync(path.join(root, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
const unit = fs.readFileSync(
  path.join(root, 'infra', 'systemd', 'shein-bi-cloud-marketing-live-guard.service'),
  'utf8',
);

const sourceAt = guard.indexOf('source "$ROOT/scripts/lib/shared_lock.sh"');
const rejectFunctionAt = guard.indexOf('reject_marketing_resume_request() {');
const rejectCallAt = guard.indexOf('if reject_marketing_resume_request; then');
assert.ok(rejectFunctionAt >= 0, 'guard must define the fail-closed resume rejector');
assert.ok(rejectCallAt >= 0 && rejectCallAt < sourceAt,
  'resume rejection must run before shared-lock loading or any helper call');
assert.match(guard, /SHEIN_BI_MARKETING_RESUME_\*\|SHEIN_BI_MARKETING_LIVE_RESUME_\*\|SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_\*/,
  'guard must reject canonical and both live/legacy resume prefixes');
assert.match(guard, /same-run marketing resume is disabled/);

for (const retiredSymbol of [
  'validate_resume_sources',
  'RESUME_MODE',
  'resumedFromRunId',
  'sourceEvidence',
]) {
  assert.doesNotMatch(guard, new RegExp(retiredSymbol),
    `retired resume machinery must not remain in the guard: ${retiredSymbol}`);
}
for (const ordinaryHelper of [
  'verify_marketing_plan_registry_preflight',
  'refresh_marketing_cost_map',
  'run_live_scan',
  'run_guard_report',
  'build_repair_queue',
]) {
  assert.match(guard, new RegExp(ordinaryHelper),
    `ordinary guard behavior must remain present: ${ordinaryHelper}`);
}

assert.match(unit, /^Environment=SHEIN_BI_MARKETING_PLAN_REGISTRY_FILE=\/srv\/shein-bi\/runtime\/marketing-plans\/current\.json$/m);
assert.doesNotMatch(unit, /SHEIN_BI_MARKETING_(?:RESUME_|LIVE_RESUME_|LIVE_GUARD_RESUME_)/,
  'live guard unit must expose no resume environment or cleanup hook');

console.log('cloud marketing live guard source contracts: ok');
