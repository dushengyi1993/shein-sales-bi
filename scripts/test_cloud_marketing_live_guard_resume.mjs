#!/usr/bin/env node

import assert from 'node:assert/strict';
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
