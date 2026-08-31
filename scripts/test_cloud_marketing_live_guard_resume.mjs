#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function toBashPath(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/');
  if (normalized.startsWith('/')) return normalized;
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2)}`;
}

function writeMarkerStub(file, marker) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    "fs.appendFileSync(process.env.SHEIN_TEST_MARKER_LOG, " + JSON.stringify(`${marker}\n`) + ");",
    'process.exit(99);',
    '',
  ].join('\n'));
}

function writeShellMarkerStub(file, marker) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `#!/usr/bin/env bash\nprintf '%s\\n' '${marker}' >> "$SHEIN_TEST_MARKER_LOG"\nexit 99\n`);
  fs.chmodSync(file, 0o755);
}

function assertFinalGuardRebuildPrecedesRepairQueueBuild() {
  const liveGuard = fs.readFileSync(path.join(repoRoot, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
  assert.match(liveGuard, /rebuild_final_guard_report_after_repair_plans\(\)/,
    'live guard must define a final guard rebuild stage');
  const finalOrchestrationStart = liveGuard.indexOf('            FINAL_GUARD_REBUILD_STATUS=0');
  const finalOrchestrationEnd = liveGuard.indexOf('        echo "[cloud_marketing_live_guard] action check', finalOrchestrationStart);
  assert.ok(finalOrchestrationStart >= 0 && finalOrchestrationEnd > finalOrchestrationStart,
    'unable to isolate final guard and repair queue orchestration');
  const finalOrchestration = liveGuard.slice(finalOrchestrationStart, finalOrchestrationEnd);
  const finalGuardIndex = finalOrchestration.indexOf('if rebuild_final_guard_report_after_repair_plans; then');
  const highClickRebindIndex = finalOrchestration.indexOf('if run_high_click_special_plan; then', finalGuardIndex);
  const queueBuildIndex = finalOrchestration.indexOf('if build_repair_queue; then', highClickRebindIndex);
  assert.ok(finalGuardIndex >= 0 && finalGuardIndex < highClickRebindIndex && highClickRebindIndex < queueBuildIndex,
    'repair queue builder must run only after final guard publication and high-click plan rebind');
  assert.match(
    finalOrchestration,
    /else\r?\n\s+HIGH_CLICK_PLAN_STATUS=\$\?\r?\n\s+REPAIR_QUEUE_BUILD_STATUS="\$HIGH_CLICK_PLAN_STATUS"/,
    'final high-click rebind failure must preserve its original status before skipping queue build',
  );
  assert.doesNotMatch(liveGuard, /!\s+rebuild_final_guard_report_after_repair_plans[\s\S]{0,160}REPAIR_QUEUE_BUILD_STATUS=\$\?/,
    'final guard rebuild failure status must not be captured from a negated command');
  assert.match(liveGuard, /FINAL_GUARD_REBUILD_STATUS=\$\?[\s\S]*REPAIR_QUEUE_BUILD_STATUS="\$FINAL_GUARD_REBUILD_STATUS"/,
    'final guard rebuild failure must preserve the original non-zero status');
}

function assertKnownOrdinaryMissingEvidenceIsAllowed15Scoped() {
  const reportBuilder = fs.readFileSync(path.join(repoRoot, 'scripts', 'marketing', 'build_marketing_daily_guard_report.mjs'), 'utf8');
  const conditionMarker = "if (knownOrdinaryEvidenceSource.status === 'missing' && Number(knownOrdinaryActivityGuard.allowed15PlanCount || 0) > 0) {";
  const conditionStart = reportBuilder.indexOf(conditionMarker);
  const conditionEnd = reportBuilder.indexOf('\n  if (!biPortal.data)', conditionStart);
  assert.ok(conditionStart >= 0 && conditionEnd > conditionStart,
    'unable to extract production known ordinary missing-evidence condition');
  const productionCondition = reportBuilder.slice(conditionStart, conditionEnd);
  const runProductionCondition = new Function(
    'knownOrdinaryEvidenceSource',
    'knownOrdinaryActivityGuard',
    'blockers',
    'addBlocker',
    productionCondition,
  );
  const execute = allowed15PlanCount => {
    const blockers = [];
    runProductionCondition(
      {status: 'missing', path: 'tmp/mbrs/deadline-fill-results'},
      {allowed15PlanCount},
      blockers,
      (target, code, message, evidence) => target.push({code, message, evidence}),
    );
    return blockers;
  };

  assert.deepEqual(execute(0), [],
    'missing known ordinary evidence must not block when allowed15PlanCount=0');
  const positiveBlockers = execute(2);
  assert.equal(positiveBlockers.length, 1,
    'missing known ordinary evidence must add one blocker when allowed15PlanCount>0');
  assert.equal(positiveBlockers[0].code, 'known_ordinary_evidence_missing');
  assert.equal(positiveBlockers[0].evidence.allowed15PlanCount, 2);
  console.log('known ordinary missing-evidence production condition: allowed15=0 blocker=0 allowed15=2 blocker=1: ok');
}

function extractBashFunction(source, functionName) {
  const pattern = new RegExp('^' + functionName + '\\(\\) \\{\\r?\\n[\\s\\S]*?^\\}', 'm');
  const match = source.match(pattern);
  assert.ok(match, 'unable to extract production Bash function ' + functionName);
  return match[0];
}

function extractFinalQueueOrchestration(source) {
  const lines = source.split(/\r?\n/);
  const assignmentIndex = lines.findIndex(line => line.trim() === 'FINAL_GUARD_REBUILD_STATUS=0');
  assert.ok(assignmentIndex >= 0, 'unable to find final guard orchestration assignment');
  const ifIndex = lines.findIndex((line, index) => index > assignmentIndex
    && line.trim() === 'if rebuild_final_guard_report_after_repair_plans; then');
  assert.ok(ifIndex === assignmentIndex + 1, 'final guard orchestration must start immediately after its status reset');
  let depth = 0;
  let endIndex = -1;
  for (let index = ifIndex; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (/^if\b/.test(trimmed)) depth += 1;
    if (trimmed === 'fi') {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
    }
  }
  assert.ok(endIndex > ifIndex, 'unable to extract complete final guard orchestration block');
  return lines.slice(assignmentIndex, endIndex + 1).join('\n');
}

function assertFinalHighClickRebindFailureFromProductionBlock() {
  const liveGuard = fs.readFileSync(path.join(repoRoot, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
  const productionBlock = extractFinalQueueOrchestration(liveGuard);
  const script = [
    'set -u',
    'HIGH_CLICK_PLAN_STATUS=0',
    'REPAIR_QUEUE_BUILD_STATUS=0',
    'QUEUE_BUILDER_CALLED=0',
    'rebuild_final_guard_report_after_repair_plans() { return 0; }',
    'run_high_click_special_plan() { return 74; }',
    'build_repair_queue() { QUEUE_BUILDER_CALLED=$((QUEUE_BUILDER_CALLED + 1)); return 0; }',
    productionBlock,
    'printf "RESULT rebind=%s repair=%s queue=%s\\n" "$HIGH_CLICK_PLAN_STATUS" "$REPAIR_QUEUE_BUILD_STATUS" "$QUEUE_BUILDER_CALLED"',
    'if [[ "$REPAIR_QUEUE_BUILD_STATUS" -ne 0 ]]; then exit 1; fi',
    'exit 0',
    '',
  ].join('\n');
  const result = spawnSync('bash', [], {input: script, encoding: 'utf8'});
  const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
  assert.equal(result.status, 1, 'final high-click rebind failure must leave service nonzero\n' + output);
  assert.match(result.stdout, /RESULT rebind=74 repair=74 queue=0/,
    'final high-click rebind failure must preserve status=74 and skip queue builder\n' + output);
  assert.match(result.stderr, /final high-click plan rebind failed status=74/,
    'final high-click rebind failure must report the exact status\n' + output);
  console.log('final high-click rebind production orchestration: status=74 queue=0 service=nonzero: ok');
}

function assertFinalGuardFailureStatusFromProductionFunction() {
  const liveGuard = fs.readFileSync(path.join(repoRoot, 'scripts', 'cloud_marketing_live_guard.sh'), 'utf8');
  const productionFunction = extractBashFunction(liveGuard, 'rebuild_final_guard_report_after_repair_plans');
  const cases = [
    {label: 'run_stage', stageStatus: 71, bindingStatus: 0, publishStatus: 0, expectedCalls: '1 0 0'},
    {label: 'binding', stageStatus: 0, bindingStatus: 72, publishStatus: 0, expectedCalls: '1 1 0'},
    {label: 'publish', stageStatus: 0, bindingStatus: 0, publishStatus: 73, expectedCalls: '1 1 1'},
  ];

  for (const testCase of cases) {
    const expectedStatus = testCase.stageStatus || testCase.bindingStatus || testCase.publishStatus;
    const script = [
      'set -u',
      'RUN_STAGE_STATUS=' + testCase.stageStatus,
      'BINDING_STATUS=' + testCase.bindingStatus,
      'PUBLISH_STATUS=' + testCase.publishStatus,
      'RUN_STAGE_CALLS=0',
      'BINDING_CALLS=0',
      'PUBLISH_CALLS=0',
      'QUEUE_BUILDER_CALLED=0',
      'REPAIR_QUEUE_BUILD_STATUS=0',
      'FINAL_GUARD_REBUILD_STATUS=0',
      'DATE=2026-08-31',
      'GUARD_STAGE_DIR=/tmp/marketing-final-guard-stage',
      'CURRENT_REGISTRY_HASH=registry-hash',
      'GUARD_OUT=/tmp/marketing-final-guard.json',
      'GUARD_INPUT_OUT=',
      'GUARD_BOUND_REGISTRY_HASH=registry-hash',
      'GUARD_BOUND_PRICE_OVERRIDES_SHA256=price-overrides-hash',
      'run_guard_report() { return 0; }',
      'run_stage_with_retry() { RUN_STAGE_CALLS=$((RUN_STAGE_CALLS + 1)); return "$RUN_STAGE_STATUS"; }',
      'validate_guard_plan_binding() { BINDING_CALLS=$((BINDING_CALLS + 1)); return "$BINDING_STATUS"; }',
      'publish_staged_guard_report() { PUBLISH_CALLS=$((PUBLISH_CALLS + 1)); return "$PUBLISH_STATUS"; }',
      'build_repair_queue() { QUEUE_BUILDER_CALLED=$((QUEUE_BUILDER_CALLED + 1)); return 0; }',
      productionFunction,
      'if rebuild_final_guard_report_after_repair_plans; then',
      '  FINAL_GUARD_REBUILD_STATUS=0',
      '  if build_repair_queue; then :; else REPAIR_QUEUE_BUILD_STATUS=$?; fi',
      'else',
      '  FINAL_GUARD_REBUILD_STATUS=$?',
      '  REPAIR_QUEUE_BUILD_STATUS="$FINAL_GUARD_REBUILD_STATUS"',
      'fi',
      'printf "RESULT function=%s repair=%s queue=%s calls=%s %s %s\\n" "$FINAL_GUARD_REBUILD_STATUS" "$REPAIR_QUEUE_BUILD_STATUS" "$QUEUE_BUILDER_CALLED" "$RUN_STAGE_CALLS" "$BINDING_CALLS" "$PUBLISH_CALLS"',
      'if [[ "$REPAIR_QUEUE_BUILD_STATUS" -ne 0 ]]; then exit 1; fi',
      'exit 0',
      '',
    ].join('\n');
    const result = spawnSync('bash', [], {input: script, encoding: 'utf8'});
    const output = String(result.stdout || '') + '\n' + String(result.stderr || '');
    assert.equal(result.status, 1, testCase.label + ' failure must leave final service nonzero\n' + output);
    assert.match(
      result.stdout,
      new RegExp('RESULT function=' + expectedStatus + ' repair=' + expectedStatus + ' queue=0 calls=' + testCase.expectedCalls),
      testCase.label + ' failure must preserve its status and skip queue builder\n' + output,
    );
    assert.match(result.stderr, new RegExp('status=' + expectedStatus),
      testCase.label + ' failure must report the preserved status\n' + output);
  }
  console.log('final guard failure propagation from production function: run_stage=71 binding=72 publish=73 queue=0 service=nonzero: ok');
}

function assertPlannerFailureSkipsFinalGuardAndQueueHarness() {
  const script = [
    'set -u',
    'HIGH_CLICK_PLAN_STATUS=0',
    'ON_SHELF_PLAN_STATUS=83',
    'MANUAL_PLAN_STATUS=0',
    'DRIFT_PLAN_STATUS=0',
    'BUILD_REPAIR_QUEUE=1',
    'REPAIR_QUEUE_BUILD_STATUS="$ON_SHELF_PLAN_STATUS"',
    'FINAL_REBUILD_CALLED=0',
    'QUEUE_BUILDER_CALLED=0',
    'rebuild_final_guard_report_after_repair_plans() { FINAL_REBUILD_CALLED=1; return 0; }',
    'build_repair_queue() { QUEUE_BUILDER_CALLED=1; return 0; }',
    'if [[ "$HIGH_CLICK_PLAN_STATUS" -eq 0 && "$ON_SHELF_PLAN_STATUS" -eq 0 && "$MANUAL_PLAN_STATUS" -eq 0 && "$DRIFT_PLAN_STATUS" -eq 0 ]]; then',
    '  if [[ "$BUILD_REPAIR_QUEUE" != "1" ]]; then :; else rebuild_final_guard_report_after_repair_plans && build_repair_queue; fi',
    'fi',
    'printf "%s %s %s\\n" "$REPAIR_QUEUE_BUILD_STATUS" "$FINAL_REBUILD_CALLED" "$QUEUE_BUILDER_CALLED"',
    'exit 1',
    '',
  ].join('\n');
  const result = spawnSync('bash', [], {input: script, encoding: 'utf8'});
  assert.notEqual(result.status, 0, 'planner failure must keep service nonzero');
  assert.match(result.stdout, /^83 0 0\s*$/, 'planner failure must skip final guard rebuild and queue builder');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertHighClickPlanRebindsFromInitialToFinalGuard() {
  fs.mkdirSync(path.join(repoRoot, 'tmp'), {recursive: true});
  const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, 'tmp', 'marketing-high-click-final-guard-rebind-'));
  const date = '2026-08-31';
  const guardPath = path.join(fixtureRoot, 'marketing-daily-guard.json');
  const priceOverridesPath = path.join(fixtureRoot, 'price-overrides.json');
  const highClickPlanPath = path.join(fixtureRoot, 'high-click-plan.json');
  const fallbackPlanPath = path.join(fixtureRoot, 'fallback-plan.json');
  const queuePath = path.join(fixtureRoot, 'repair-queue.json');
  const plannerScript = path.join(repoRoot, 'scripts', 'marketing', 'build_high_click_special_discount_plan.mjs');
  const queueScript = path.join(repoRoot, 'scripts', 'marketing', 'manage_marketing_repair_queue.mjs');
  const relative = file => path.relative(repoRoot, file).replaceAll(path.sep, '/');
  const writeJson = (file, value) => {
    const content = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(file, content, 'utf8');
    return content;
  };
  const runPlanner = () => spawnSync(process.execPath, [
    plannerScript,
    '--date', date,
    '--guard', guardPath,
    '--out', highClickPlanPath,
  ], {cwd: repoRoot, encoding: 'utf8'});
  const runQueueBuilder = () => spawnSync(process.execPath, [
    queueScript,
    'build',
    '--date', date,
    '--guard', guardPath,
    '--high-click-plan', highClickPlanPath,
    '--fallback-plan', fallbackPlanPath,
    '--queue', queuePath,
  ], {cwd: repoRoot, encoding: 'utf8'});

  try {
    const priceOverridesText = writeJson(priceOverridesPath, {schemaVersion: 1, items: []});
    const priceOverridesHash = sha256(priceOverridesText);
    const scanRelativePath = relative(path.join(fixtureRoot, 'current-marketing-live-scan.json'));
    const baseGuard = {
      schemaVersion: 1,
      reportDate: date,
      targetPlanSelection: {
        priceOverrides: relative(priceOverridesPath),
        priceOverridesHash,
      },
      highClickLowConversionSpecial: {
        qualifyingCount: 0,
        protectedCount: 0,
        blockedCount: 0,
        actionCount: 0,
        rows: [],
      },
      manualSpecialLimitedDiscount: {actionCount: 0},
      limitedDiscountTargetPriceDrift: {
        source: scanRelativePath,
        belowRows: [],
      },
    };
    const guardAText = writeJson(guardPath, {...baseGuard, fixtureRevision: 'initial-A'});
    const guardHashA = sha256(guardAText);
    const initialPlanRun = runPlanner();
    assert.equal(initialPlanRun.status, 0,
      'initial high-click plan generation must succeed\n' + initialPlanRun.stdout + '\n' + initialPlanRun.stderr);
    const planA = JSON.parse(fs.readFileSync(highClickPlanPath, 'utf8'));
    assert.equal(planA.sourceGuardHash, guardHashA, 'initial high-click plan must bind guard hash A');

    const guardBText = writeJson(guardPath, {...baseGuard, fixtureRevision: 'final-B'});
    const guardHashB = sha256(guardBText);
    assert.notEqual(guardHashB, guardHashA, 'final guard hash B must differ from initial guard hash A');
    writeJson(fallbackPlanPath, {
      schemaVersion: 1,
      reportDate: date,
      sourceGuard: relative(guardPath),
      sourceCurrentMarketingLiveScan: scanRelativePath,
      sourcePriceOverrides: relative(priceOverridesPath),
      sourcePriceOverridesSha256: priceOverridesHash,
      rescueFiles: [],
    });

    const staleQueueRun = runQueueBuilder();
    assert.notEqual(staleQueueRun.status, 0, 'queue builder must reject plan A after guard changes to B');
    assert.match(
      staleQueueRun.stderr,
      new RegExp('High-click special plan guard hash mismatch: expected=' + guardHashB + ' actual=' + guardHashA),
      'real loader must report the exact A-to-B high-click guard hash mismatch',
    );
    assert.equal(fs.existsSync(queuePath), false, 'stale high-click plan must not create a repair queue');

    const rebindPlanRun = runPlanner();
    assert.equal(rebindPlanRun.status, 0,
      'final high-click plan rebind must succeed\n' + rebindPlanRun.stdout + '\n' + rebindPlanRun.stderr);
    const planB = JSON.parse(fs.readFileSync(highClickPlanPath, 'utf8'));
    assert.equal(planB.sourceGuardHash, guardHashB, 'rebound high-click plan must bind final guard hash B');

    const finalQueueRun = runQueueBuilder();
    assert.equal(finalQueueRun.status, 0,
      'queue builder must accept high-click plan rebound to guard B\n' + finalQueueRun.stdout + '\n' + finalQueueRun.stderr);
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    assert.equal(queue.sourceGuardHash, guardHashB, 'repair queue must bind final guard hash B');
    assert.equal(queue.stages.highClickSpecial.status, 'not_required',
      'zero-action high-click plan must still load exactly and remain not_required');
    console.log('high-click final guard rebind via real planner/loader/queue: stale A rejected, plan=B queue=B: ok');
  } finally {
    fs.rmSync(fixtureRoot, {recursive: true, force: true});
  }
}

function createFixture() {
  fs.mkdirSync(path.join(repoRoot, 'tmp'), {recursive: true});
  const root = fs.mkdtempSync(path.join(repoRoot, 'tmp', 'marketing-live-guard-resume-disabled-'));
  const markerLog = path.join(root, 'effects.log');
  const guardPath = path.join(root, 'scripts', 'cloud_marketing_live_guard.sh');
  const binDir = path.join(root, 'bin');

  fs.mkdirSync(path.dirname(guardPath), {recursive: true});
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'cloud_marketing_live_guard.sh'), guardPath);
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), {recursive: true});
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'shared_lock.sh'), [
    '#!/usr/bin/env bash',
    "printf '%s\\n' 'shared-lock' >> \"$SHEIN_TEST_MARKER_LOG\"",
    'prepare_shared_lock_file() { :; }',
    '',
  ].join('\n'));

  const mjsHelpers = [
    ['scripts/marketing/scan_current_marketing_prices_for_bi.mjs', 'collector-scan'],
    ['scripts/marketing/export_marketing_stack_review.mjs', 'collector-stack'],
    ['scripts/marketing/build_marketing_daily_guard_report.mjs', 'guard-builder'],
    ['scripts/marketing/build_high_click_special_discount_plan.mjs', 'planner-high-click'],
    ['scripts/marketing/build_new_listing_limited_discount_plan.mjs', 'planner-on-shelf'],
    ['scripts/marketing/build_manual_limited_discount_restore_plan.mjs', 'planner-manual'],
    ['scripts/marketing/build_limited_discount_drift_rescue_plan.mjs', 'planner-drift'],
    ['scripts/marketing/manage_marketing_repair_queue.mjs', 'repair-queue'],
    ['scripts/marketing/export_marketing_price_leads_for_bi.mjs', 'price-leads'],
    ['scripts/marketing/send_marketing_daily_group_report.mjs', 'group-report'],
  ];
  for (const [relative, marker] of mjsHelpers) {
    writeMarkerStub(path.join(root, relative), marker);
  }
  fs.mkdirSync(binDir, {recursive: true});
  writeShellMarkerStub(path.join(binDir, 'python3'), 'collector-cost-map');
  writeShellMarkerStub(path.join(root, 'scripts', 'publish_marketing_price_leads_to_bi.sh'), 'bi-queue');

  return {
    root,
    markerLog,
    guardPath,
    binDir,
    sideEffectPaths: [
      markerLog,
      path.join(root, 'state'),
      path.join(root, 'logs'),
      path.join(root, 'tmp'),
      path.join(root, 'outputs'),
    ],
  };
}

const resumeNames = [
  'SHEIN_BI_MARKETING_RESUME_FROM_RUN_ID',
  'SHEIN_BI_MARKETING_RESUME_RUN_ID',
  'SHEIN_BI_MARKETING_RESUME_SCAN_PATH',
  'SHEIN_BI_MARKETING_LIVE_RESUME_FROM_RUN_ID',
  'SHEIN_BI_MARKETING_LIVE_RESUME_RUN_ID',
  'SHEIN_BI_MARKETING_LIVE_RESUME_SCAN_PATH',
  'SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_FROM_RUN_ID',
  'SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_SCAN_PATH',
];

function bashQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runGuard(fixture, request) {
  const cleanParentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:SHEIN_BI_MARKETING_RESUME_|SHEIN_BI_MARKETING_LIVE_RESUME_|SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_)/.test(name)),
  );
  const variables = {
    SHEIN_BI_ROOT: toBashPath(fixture.root),
    SHEIN_BI_MARKETING_LIVE_DATE: '2026-08-24',
    SHEIN_BI_MARKETING_LIVE_RUN_ID: 'fresh-run-never-reached',
    SHEIN_TEST_MARKER_LOG: toBashPath(fixture.markerLog),
    PATH: `${toBashPath(fixture.binDir)}:/usr/bin:/bin`,
    ...request,
  };
  const input = [
    ...resumeNames.map(name => `unset ${name}`),
    ...Object.entries(variables).map(([name, value]) => `export ${name}=${bashQuote(value)}`),
    `bash ${bashQuote(toBashPath(fixture.guardPath))}`,
    '',
  ].join('\n');
  return spawnSync('bash', [], {
    cwd: repoRoot,
    env: cleanParentEnv,
    encoding: 'utf8',
    input,
  });
}

function assertRejected(fixture, label, request) {
  const result = runGuard(fixture, request);
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.notEqual(result.status, 0, `${label} must be rejected\n${output}`);
  assert.equal(result.status, 64, `${label} must use the fail-closed status\n${output}`);
  assert.match(output, /same-run marketing resume is disabled/);
  assert.equal(fs.existsSync(fixture.markerLog), false, `${label}: no helper call marker may be created`);
  for (const file of fixture.sideEffectPaths.slice(1)) {
    assert.equal(fs.existsSync(file), false, `${label}: no side effect may create ${file}`);
  }
}

assertFinalGuardRebuildPrecedesRepairQueueBuild();
assertKnownOrdinaryMissingEvidenceIsAllowed15Scoped();
assertFinalGuardFailureStatusFromProductionFunction();
assertFinalHighClickRebindFailureFromProductionBlock();
assertPlannerFailureSkipsFinalGuardAndQueueHarness();
assertHighClickPlanRebindsFromInitialToFinalGuard();

const fixture = createFixture();
try {
  assertRejected(fixture, 'canonical modern resume', {
    SHEIN_BI_MARKETING_RESUME_RUN_ID: 'modern-source-run',
  });
  assertRejected(fixture, 'live modern resume', {
    SHEIN_BI_MARKETING_LIVE_RESUME_FROM_RUN_ID: 'modern-live-source-run',
  });
  assertRejected(fixture, 'legacy live-guard resume', {
    SHEIN_BI_MARKETING_LIVE_GUARD_RESUME_FROM_RUN_ID: 'legacy-source-run',
  });
  assertRejected(fixture, 'empty canonical resume request', {
    SHEIN_BI_MARKETING_RESUME_RUN_ID: '',
  });
  console.log('cloud marketing live guard resume disablement: ok');
} finally {
  fs.rmSync(fixture.root, {recursive: true, force: true});
}
