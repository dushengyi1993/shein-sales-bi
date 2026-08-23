#!/usr/bin/env node
/**
 * CLI-level deterministic test for prepare-publish --reuse-approved-binding.
 *
 * Drives scripts/bi_ops_cli.mjs against a minimal mock BI portal HTTP server
 * (session file is pre-seeded; no login, no real SHEIN). Proves:
 *   - reuse mode records exactly one /api/link-ops-publish-assets call with
 *     body sourceApproved=true, reuseApprovedBinding=true, bindings=[] and the
 *     publishPreparationFromArgs result;
 *   - zero /api/openapi-image-asset/upload-pic calls (no local scan/read/upload);
 *   - exactly one /api/link-ops-execute dry-run and realPublishOccurred=false;
 *   - fail-closed mutual exclusion with --image-dir and with --source-task-id;
 *   - the old path still requires --image-dir (no regression).
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'bi_ops_cli.mjs');
const KEEP_TEMP = process.argv.includes('--keep-temp');
const tmpBase = path.join(ROOT, 'tmp');
await fs.mkdir(tmpBase, {recursive: true});
const tmpRoot = await fs.mkdtemp(path.join(tmpBase, 'cli-reuse-approved-binding-'));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      resolve({text, json});
    });
    req.on('error', reject);
  });
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
  res.end(JSON.stringify(value));
}

const calls = [];
const callsTo = p => calls.filter(call => call.path === p);

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  const {json} = await readBody(req);
  calls.push({path: pathname, method: req.method, json});
  if (pathname.startsWith('/api/owner-knowledge/')) {
    // The CLI degrades this to a warning and continues; keeps the test offline.
    sendJson(res, {ok: false, error: 'manifest not configured in mock'}, 404);
    return;
  }
  if (pathname === '/api/link-ops-publish-assets' && req.method === 'POST') {
    sendJson(res, {
      ok: true,
      task: {id: String(json?.taskId || ''), status: 'waiting_review'},
      binding: {
        payloadSource: 'task',
        bindingFingerprint: 'mock-binding-fp-001',
        imageCount: 3,
        squareDimensions: '1254x1254',
        boundNames: ['approved-main.png', 'approved-detail-1.png', 'approved-square.png'],
        ...(json?.allowEmptyDescription === true ? {
          emptyDescriptionAuthorization: {ok: true, stale: false},
        } : {}),
      },
    });
    return;
  }
  if (pathname === '/api/link-ops-execute' && req.method === 'POST') {
    sendJson(res, {
      ok: true,
      task: {id: String(json?.id || ''), status: 'waiting_review'},
      execution: {
        state: 'preflight_ok',
        preflight: {ok: true, blockers: [], warnings: []},
        writeAudit: {sheinWriteAttempted: false},
      },
    });
    return;
  }
  if (pathname === '/api/openapi-image-asset/upload-pic' && req.method === 'POST') {
    // Present only to prove the reuse path never calls it.
    sendJson(res, {ok: true, result: {imageUrl: 'https://img.shein.com/mock-upload.png'}});
    return;
  }
  sendJson(res, {ok: false, error: `mock no route: ${req.method} ${pathname}`}, 404);
});

const checks = [];
function check(label, actual, expected) {
  const pass = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({label, actual: typeof expected === 'function' ? 'predicate' : actual, expected: typeof expected === 'function' ? 'predicate' : expected, pass});
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        SHEIN_BI_KNOWLEDGE_CACHE_DIR: path.join(tmpRoot, 'knowledge'),
        SHEIN_BI_PARTNER_CHECK_TTL_MS: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({code, stdout, stderr}));
    child.on('error', reject);
  });
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const actualPort = server.address().port;
  const usedBaseUrl = `http://127.0.0.1:${actualPort}`;
  const sessionFile = path.join(tmpRoot, 'ops-session.json');
  await fs.writeFile(sessionFile, JSON.stringify({
    baseUrl: usedBaseUrl,
    cookie: 'bi_session=test-session-cookie',
    savedAt: new Date().toISOString(),
    note: 'mock session only',
  }, null, 2), 'utf8');

  const publishPreparation = {
    titleGroup: '',
    standardGoodsSn: '',
    supplierSku: '',
    supplyPrice: 210,
    inventory: 100,
    categoryId: null,
    titleAr: '',
    titleEn: '',
    attributeOverrides: [{
      attribute_id: 1002323,
      attribute_extra_value: '700',
      attribute_unit: 'mA',
      label: '输入电流',
      source: 'explicit_prepare_publish',
    }],
  };

  const common = [
    '--base-url', usedBaseUrl,
    '--session-file', sessionFile,
  ];

  // Case 1: happy reuse path — exactly one binding call, zero upload-pic, one dry-run.
  const happyArgs = [
    'prepare-publish', '--task-id', 'task-101', '--store', 'HL',
    '--reuse-approved-binding', '--supply-price', '210', '--inventory', '100',
    '--input-current-ma', '700', ...common,
  ];
  const happy = await runCli(happyArgs);
  let happyJson = null;
  try { happyJson = JSON.parse(happy.stdout.trim()); } catch {}
  const publishCalls = callsTo('/api/link-ops-publish-assets');
  const executeCalls = callsTo('/api/link-ops-execute');
  const uploadCalls = callsTo('/api/openapi-image-asset/upload-pic');
  check('reuse exit code 0', happy.code, 0);
  check('reuse stdout ok', happyJson?.ok, true);
  check('reuse marks reuseApprovedBinding', happyJson?.reuseApprovedBinding, true);
  check('reuse reports zero uploaded images', happyJson?.uploaded || [], []);
  check('reuse reports no local scan', happyJson?.plan, plan => (
    plan?.source === 'existing_task_publishAssetBinding'
    && plan?.scannedImages === 0
    && plan?.eligibleImages === 0
  ));
  check('reuse safety realPublishOccurred=false', happyJson?.safety?.realPublishOccurred, false);
  check('reuse safety reusedApprovedBinding=true', happyJson?.safety?.reusedApprovedBinding, true);
  check('reuse safety payloadSource from binding', happyJson?.safety?.payloadSource, 'task');
  check('reuse binding endpoint called exactly once', publishCalls.length, 1);
  check('reuse binding body exact', publishCalls[0]?.json || null, {
    taskId: 'task-101',
    store: 'HL',
    sourceApproved: true,
    reuseApprovedBinding: true,
    bindings: [],
    publishPreparation,
  });
  check('reuse binding body has no local-image fields', Object.keys(publishCalls[0]?.json || {}), ['taskId', 'store', 'sourceApproved', 'reuseApprovedBinding', 'bindings', 'publishPreparation']);
  check('reuse dry-run called exactly once', executeCalls.length, 1);
  check('reuse dry-run body exact', executeCalls[0]?.json || null, {
    id: 'task-101',
    mode: 'dry-run',
    source: 'codex_desktop_cli_prepare_publish',
  });
  check('reuse zero upload-pic calls', uploadCalls.length, 0);
  check('reuse never calls image role planner endpoint', callsTo('/api/link-ops-image-roles').length, 0);

  // Case 2: explicit-empty mode forwards only the exact paired opt-in fields.
  calls.length = 0;
  const empty = await runCli([
    'prepare-publish', '--task-id', 'task-empty-101', '--store', 'HL',
    '--reuse-approved-binding', '--supply-price', '210', '--inventory', '100',
    '--allow-empty-description', '--empty-description-confirm', 'USER_EXPLICIT_EMPTY_DESCRIPTION',
    ...common,
  ]);
  let emptyJson = null;
  try { emptyJson = JSON.parse(empty.stdout.trim()); } catch {}
  const emptyPublishCalls = callsTo('/api/link-ops-publish-assets');
  check('empty mode exit code 0', empty.code, 0);
  check('empty mode stdout ok', emptyJson?.ok, true);
  check('empty mode reports server authorization', emptyJson?.safety?.emptyDescriptionAuthorized, true);
  check('empty mode binding endpoint called once', emptyPublishCalls.length, 1);
  check('empty mode request carries exact opt-in pair', {
    allowEmptyDescription: emptyPublishCalls[0]?.json?.allowEmptyDescription,
    emptyDescriptionConfirm: emptyPublishCalls[0]?.json?.emptyDescriptionConfirm,
  }, {
    allowEmptyDescription: true,
    emptyDescriptionConfirm: 'USER_EXPLICIT_EMPTY_DESCRIPTION',
  });
  check('empty mode still uses zero uploads', callsTo('/api/openapi-image-asset/upload-pic').length, 0);
  check('empty mode still performs exactly one dry-run', callsTo('/api/link-ops-execute').length, 1);

  // Mismatched or unpaired confirmation must fail before any HTTP request.
  calls.length = 0;
  const emptyWrongToken = await runCli([
    'prepare-publish', '--task-id', 'task-empty-102', '--store', 'HL',
    '--reuse-approved-binding', '--allow-empty-description',
    '--empty-description-confirm', 'WRONG_TOKEN', ...common,
  ]);
  check('empty mode wrong token exits non-zero', emptyWrongToken.code === 0, false);
  check('empty mode wrong token explains exact token', emptyWrongToken.stderr, text => /USER_EXPLICIT_EMPTY_DESCRIPTION/.test(text));
  check('empty mode wrong token performs zero binding calls', callsTo('/api/link-ops-publish-assets').length, 0);
  check('empty mode wrong token performs zero dry-run calls', callsTo('/api/link-ops-execute').length, 0);

  // Case 3: --reuse-approved-binding + --image-dir must fail closed before any request.
  calls.length = 0;
  const mutexDir = await runCli([
    'prepare-publish', '--task-id', 'task-102', '--store', 'HL',
    '--reuse-approved-binding', '--image-dir', path.join(tmpRoot, 'no-such-dir'), ...common,
  ]);
  check('mutex image-dir exit non-zero', mutexDir.code === 0, false);
  check('mutex image-dir explains exclusion', mutexDir.stderr, text => /互斥/.test(text));
  check('mutex image-dir zero binding calls', callsTo('/api/link-ops-publish-assets').length, 0);
  check('mutex image-dir zero dry-run calls', callsTo('/api/link-ops-execute').length, 0);
  check('mutex image-dir zero upload-pic calls', callsTo('/api/openapi-image-asset/upload-pic').length, 0);

  // Case 4: --reuse-approved-binding + --source-task-id (update_images mode) must fail closed.
  calls.length = 0;
  const mutexSource = await runCli([
    'prepare-publish', '--task-id', 'task-103', '--store', 'HL',
    '--reuse-approved-binding', '--source-task-id', 'SRC-9', ...common,
  ]);
  check('mutex source-task-id exit non-zero', mutexSource.code === 0, false);
  check('mutex source-task-id explains copy_product_draft only', mutexSource.stderr, text => /copy_product_draft/.test(text) && /source-task-id/.test(text));
  check('mutex source-task-id zero binding calls', callsTo('/api/link-ops-publish-assets').length, 0);
  check('mutex source-task-id zero dry-run calls', callsTo('/api/link-ops-execute').length, 0);

  // Case 5: old path without --reuse-approved-binding still requires --image-dir.
  calls.length = 0;
  const oldPath = await runCli([
    'prepare-publish', '--task-id', 'task-104', '--store', 'HL', ...common,
  ]);
  check('old path requires --image-dir', oldPath.code === 0, false);
  check('old path error mentions --image-dir', oldPath.stderr, text => /requires --image-dir/.test(text));
  check('old path zero binding calls', callsTo('/api/link-ops-publish-assets').length, 0);
  check('old path zero dry-run calls', callsTo('/api/link-ops-execute').length, 0);

  const failed = checks.filter(row => !row.pass);
  for (const row of checks) {
    console.log(`${row.pass ? '✓' : '✗'} ${row.label}`);
    if (!row.pass) {
      console.log(`    actual:   ${JSON.stringify(row.actual)}`);
      console.log(`    expected: ${JSON.stringify(row.expected)}`);
    }
  }
  console.log(`\nprepare-publish --reuse-approved-binding CLI test: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.error(`FAILED ${failed.length} check(s); keep temp: ${KEEP_TEMP ? tmpRoot : '(cleaned)'}`);
    process.exitCode = 1;
  } else {
    console.log(`OK (temp ${KEEP_TEMP ? tmpRoot : 'cleaned'}): reuse binding body + zero upload-pic + exact dry-run + fail-closed guards + old-path regression`);
  }
  server.close();
  if (!KEEP_TEMP) {
    await fs.rm(tmpRoot, {recursive: true, force: true}).catch(() => {});
  }
}

await run();
