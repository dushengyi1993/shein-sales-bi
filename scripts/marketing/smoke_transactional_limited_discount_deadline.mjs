#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  loadMarketingTransactionJournal,
  MarketingTransactionJournalError,
} from './replace_limited_discount_transactionally.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHILD = 'scripts/marketing/replace_limited_discount_transactionally.mjs';

async function run(args, env) {
  return await new Promise(resolve => {
    const child = spawn(process.execPath, [CHILD, ...args], {
      cwd: ROOT,
      env: {...process.env, ...env},
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function parseLastJson(text) {
  const source = String(text || '').trim();
  for (let start = source.lastIndexOf('{'); start >= 0; start = source.lastIndexOf('{', start - 1)) {
    try { return JSON.parse(source.slice(start)); } catch {}
  }
  throw new Error(`no trailing JSON object: ${source.slice(-1000)}`);
}

function extractFunction(source, name) {
  const marker = `export function ${name}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must remain exported for focused resume testing`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1).replace(/^export\s+/, '');
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function loadResumeFunctions(source, names, globals = {}) {
  const context = vm.createContext({...globals});
  const declarations = names.map(name => extractFunction(source, name)).join('\n');
  const exports = names.map(name => `${JSON.stringify(name)}: ${name}`).join(',');
  return vm.runInContext(`${declarations}\n({${exports}})`, context);
}

await fs.mkdir(path.join(ROOT, 'tmp'), {recursive: true});
const temp = await fs.mkdtemp(path.join(ROOT, 'tmp', 'limited-discount-deadline-'));
try {
  const clockFile = path.join(temp, 'clock.txt');
  const stateFile = path.join(temp, 'state.json');
  const eventsFile = path.join(temp, 'events.ndjson');
  const applyFile = path.join(temp, 'fake-apply.mjs');
  const removeFile = path.join(temp, 'fake-remove.mjs');
  const preloadFile = path.join(temp, 'clock-preload.cjs');
  const rescueFile = path.join(temp, 'rescue.json');
  const baseEpoch = 2_000_000_000;
  const gracefulEpoch = baseEpoch + 300;
  const outerEpoch = baseEpoch + 1_200;
  const rescue = {
    storeKey: 'DL',
    purpose: 'focused_deadline_contract',
    sourceLimitedDiscountName: 'old activity',
    activityNamePrefix: 'desired activity',
    endTime: '2099-12-31 23:59:59',
    activityStock: 10,
    rows: [{storeKey: 'DL', skc: 'DEADLINE-SKC-1', limitedDiscountPrice: 80, activityStock: 10}],
  };
  await fs.writeFile(rescueFile, JSON.stringify(rescue));
  const rescueHash = crypto.createHash('sha256').update(await fs.readFile(rescueFile)).digest('hex');
  const commonJsRequire = 'requ' + 'ire';
  await fs.writeFile(preloadFile, `const fs=${commonJsRequire}('node:fs');Date.now=()=>Number(fs.readFileSync(process.env.FOCUSED_CLOCK,'utf8'))*1000;`);
  await fs.writeFile(applyFile, `
import fs from 'node:fs/promises';
import path from 'node:path';
const argv=process.argv.slice(2);const value=k=>argv[argv.indexOf(k)+1];const execute=argv.includes('--execute');
const rescue=JSON.parse(await fs.readFile(value('--rescue'),'utf8'));const state=JSON.parse(await fs.readFile(process.env.FOCUSED_STATE,'utf8'));
const compensation=String(rescue.purpose||'').includes('compensation_restore');const skc=String(rescue.rows[0].skc);
const epoch=Number(await fs.readFile(process.env.FOCUSED_CLOCK,'utf8'));
await fs.appendFile(process.env.FOCUSED_EVENTS,JSON.stringify({tool:'apply',execute,compensation,epoch})+'\\n');
let full;
if(state.oldCovered){
  full={ok:false,before:{conflictActivities:[{activity_id:111,act_name:'old activity',state:3,start_time:'2026-01-01 00:00:00',end_time:'2099-12-31 23:59:59',targetSkcs:[skc],extraSkcs:[],targetGoods:[{skc,sku_supplier_no:'OLD',product_act_price:70,attend_num_sum:10,stock_num:10}]}]},validation:{missing:[],invalid:[{skc,reason:'query_goods error_code',error_code:'mrs-simple_platform_limit_discounts-0006'}]}};
}else if(compensation&&execute){
  full={ok:true,writeAttempted:true,createdActivityId:222,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:[{skc,ok:true}],conflictActivities:[]}};
}else if(compensation){
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else if(execute&&state.failDesired){
  full={ok:false,writeAttempted:true,status:'submitted_without_exact_readback',reason:'simulated exact readback unavailable',before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
}else if(execute){
  full={ok:true,writeAttempted:true,createdActivityId:333,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:{exactReadbackRows:[{skc,ok:true}],conflictActivities:[]}};
}else{
  full={ok:true,before:{conflictActivities:[]},validation:{missing:[],invalid:[]},after:null};
  if(state.advancePreflight&&!state.preflightAdvanced){state.preflightAdvanced=true;await fs.writeFile(process.env.FOCUSED_STATE,JSON.stringify(state));await fs.writeFile(process.env.FOCUSED_CLOCK,String(Number(process.env.FOCUSED_OUTER)-899));}
}
const out=path.join(process.env.FOCUSED_DIR,'apply-'+Date.now()+'-'+Math.random()+'.json');await fs.writeFile(out,JSON.stringify(full));
console.log(JSON.stringify({ok:full.ok,out}));if(!full.ok)process.exitCode=2;
`);
  await fs.writeFile(removeFile, `
import fs from 'node:fs/promises';import path from 'node:path';
const argv=process.argv.slice(2);const execute=argv.includes('--execute');const state=JSON.parse(await fs.readFile(process.env.FOCUSED_STATE,'utf8'));
const epoch=Number(await fs.readFile(process.env.FOCUSED_CLOCK,'utf8'));await fs.appendFile(process.env.FOCUSED_EVENTS,JSON.stringify({tool:'remove',execute,epoch})+'\\n');
const before={missingToRemove:[],goods:[{skc:'DEADLINE-SKC-1',sku_supplier_no:'OLD',product_act_price:70,attend_num_sum:10,stock_num:10}]};
if(execute){state.oldCovered=false;await fs.writeFile(process.env.FOCUSED_STATE,JSON.stringify(state));await fs.writeFile(process.env.FOCUSED_CLOCK,String(Number(process.env.FOCUSED_OUTER)+1));}
const full={ok:true,writeAttempted:execute,results:[{ok:true,before,after:execute?{stillPresent:[],missingPreserved:[],unexpectedAdded:[]}:null}]};
const out=path.join(process.env.FOCUSED_DIR,'remove-'+Date.now()+'-'+Math.random()+'.json');await fs.writeFile(out,JSON.stringify(full));console.log(JSON.stringify({ok:true,out}));
`);

  const env = {
    NODE_OPTIONS: `--require=${JSON.stringify(preloadFile)}`,
    FOCUSED_CLOCK: clockFile,
    FOCUSED_STATE: stateFile,
    FOCUSED_EVENTS: eventsFile,
    FOCUSED_DIR: temp,
    FOCUSED_OUTER: String(outerEpoch),
    SHEIN_MARKETING_APPLY_SCRIPT: applyFile,
    SHEIN_MARKETING_REMOVE_SCRIPT: removeFile,
    SHEIN_BI_MARKETING_AUTOMATION_CONTEXT: 'cloud_timer',
    SHEIN_BI_MARKETING_AUTOMATION_AUTHORIZATION: 'owner-standing-cloud-marketing-v1',
    SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH: 'a'.repeat(64),
  };
  const commonArgs = [
    '--store', 'DL', '--port', '9999', '--rescue', rescueFile,
    '--expected-rescue-hash', rescueHash, '--execute',
    '--graceful-cutoff-epoch', String(gracefulEpoch),
    '--outer-hard-deadline-epoch', String(outerEpoch),
    '--min-finalization-budget-sec', '900',
  ];

  for (const code of ['EACCES', 'EIO']) {
    await assert.rejects(
      () => loadMarketingTransactionJournal(path.join(temp, `${code}.json`), {
        readFile: async () => { const error = new Error(`injected ${code}`); error.code = code; throw error; },
      }),
      error => error instanceof MarketingTransactionJournalError
        && error.code === 'MARKETING_TRANSACTION_JOURNAL_READ_FAILED'
        && error.message.includes(code),
      `${code} journal read must never downgrade to an absent journal`,
    );
  }

  for (const badJournal of [
    {name: 'truncated-json', bytes: '{not-json', code: 'MARKETING_TRANSACTION_JOURNAL_PARSE_FAILED'},
    {name: 'non-object-json', bytes: '[]\n', code: 'MARKETING_TRANSACTION_JOURNAL_SCHEMA_INVALID'},
    {name: 'unsupported-schema', bytes: '{"schemaVersion":999}\n', code: 'MARKETING_TRANSACTION_JOURNAL_SCHEMA_INVALID'},
  ]) {
    await fs.writeFile(clockFile, String(baseEpoch));
    await fs.writeFile(stateFile, JSON.stringify({oldCovered: false}));
    await fs.writeFile(eventsFile, '');
    const transactionId = `bad-journal-${badJournal.name}`;
    const journalDir = path.join(temp, `bad-journal-dir-${badJournal.name}`);
    const outDir = path.join(temp, `bad-journal-out-${badJournal.name}`);
    await fs.mkdir(journalDir, {recursive: true});
    const journalPath = path.join(journalDir, `limited-discount-tx-DL-${transactionId}.json`);
    await fs.writeFile(journalPath, badJournal.bytes);
    const originalBytes = await fs.readFile(journalPath);
    const failed = await run([
      ...commonArgs, '--transaction-id', transactionId,
      '--out-dir', outDir, '--journal-dir', journalDir,
    ], env);
    assert.notEqual(failed.code, 0, `${badJournal.name} journal must fail closed`);
    assert.match(failed.stderr, new RegExp(badJournal.code));
    const failedEvents = (await fs.readFile(eventsFile, 'utf8')).trim()
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const executeCalls = failedEvents.filter(event => event.execute).length;
    const readbackCalls = failedEvents.filter(event => !event.execute).length;
    const createCalls = failedEvents.filter(event => event.tool === 'apply' && event.execute).length;
    assert.deepEqual({executeCalls, readbackCalls, createCalls},
      {executeCalls: 0, readbackCalls: 0, createCalls: 0},
      `${badJournal.name} must stop before any dry-run, readback, delete, or create child call`);
    assert.deepEqual(await fs.readFile(journalPath), originalBytes,
      `${badJournal.name} journal bytes must remain untouched for audit/recovery`);
  }

  await fs.writeFile(clockFile, String(baseEpoch));
  await fs.writeFile(stateFile, JSON.stringify({oldCovered: false, advancePreflight: true}));
  await fs.writeFile(eventsFile, '');
  const crossedBeforeMutation = await run([
    ...commonArgs, '--transaction-id', 'preflight-crosses-outer-budget',
    '--out-dir', path.join(temp, 'preflight-out'), '--journal-dir', path.join(temp, 'preflight-journal'),
  ], env);
  assert.equal(crossedBeforeMutation.code, 4, crossedBeforeMutation.stderr || crossedBeforeMutation.stdout);
  assert.match(crossedBeforeMutation.stderr, /MARKETING_DEADLINE_OUTER_BUDGET|cannot start without 900s/);
  let events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.some(event => event.execute), false, 'preflight crossing the outer reserve must produce zero writes');

  await fs.writeFile(clockFile, String(baseEpoch));
  await fs.writeFile(stateFile, JSON.stringify({oldCovered: false}));
  await fs.writeFile(eventsFile, '');
  const uncertainArgs = [
    ...commonArgs, '--transaction-id', 'create-return-before-journal-result',
    '--out-dir', path.join(temp, 'uncertain-out'), '--journal-dir', path.join(temp, 'uncertain-journal'),
  ];
  const interruptedCreate = await run(uncertainArgs, {
    ...env,
    SHEIN_MARKETING_FAULT_AFTER_CREATE_RETURN_BEFORE_JOURNAL: '1',
  });
  assert.equal(interruptedCreate.code, 4, interruptedCreate.stderr || interruptedCreate.stdout);
  assert.match(interruptedCreate.stderr, /fault injection after create return before journal result persistence/);
  events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(event => event.tool === 'apply' && event.execute).length, 1,
    'fault injection must occur after exactly one accepted create call');
  const uncertainResume = await run(uncertainArgs, env);
  assert.equal(uncertainResume.code, 2, uncertainResume.stderr || uncertainResume.stdout);
  const uncertainResult = parseLastJson(uncertainResume.stdout);
  assert.equal(uncertainResult.classification, 'submitted_without_exact_readback');
  assert.equal(uncertainResult.readbackOnly, true);
  assert.equal(uncertainResult.operation.state, 'create_started');
  assert.equal(uncertainResult.operation.workFingerprint, env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH);
  events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(event => event.tool === 'apply' && event.execute).length, 1,
    'create_started without a persisted result must be permanently readback-only and never replay create');

  for (const malicious of [
    {name: 'missing-create-attempt'},
    {name: 'phase-only-missing-create-attempt', mutationsStarted: false},
    {name: 'mismatched-operation-id', createAttempt: {operationId: '0'.repeat(64)}},
    {name: 'mismatched-exact-transaction', createAttempt: {exactTransactionId: 'attacker-transaction'}},
  ]) {
    await fs.writeFile(clockFile, String(baseEpoch));
    await fs.writeFile(stateFile, JSON.stringify({oldCovered: false}));
    await fs.writeFile(eventsFile, '');
    const transactionId = `malicious-${malicious.name}`;
    const journalDir = path.join(temp, `malicious-journal-${malicious.name}`);
    const outDir = path.join(temp, `malicious-out-${malicious.name}`);
    await fs.mkdir(journalDir, {recursive: true});
    const exactScope = {
      storeKey: 'DL',
      transactionId: malicious.createAttempt?.exactTransactionId || transactionId,
      rescuePath: path.relative(ROOT, rescueFile).replaceAll(path.sep, '/'),
      rescueHash,
      targetSkcs: ['DEADLINE-SKC-1'],
    };
    const createAttempt = malicious.createAttempt ? {
      schemaVersion: 1,
      operation: 'limited_discount_create',
      operationId: malicious.createAttempt.operationId || crypto.createHash('sha256').update(JSON.stringify({
        role: 'create_only',
        workFingerprint: env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH,
        exactScope,
      })).digest('hex'),
      role: 'create_only',
      state: 'create_started',
      attempt: 1,
      startedAt: new Date(baseEpoch * 1000).toISOString(),
      workFingerprint: env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH,
      exactScope,
    } : undefined;
    await fs.writeFile(path.join(journalDir, `limited-discount-tx-DL-${transactionId}.json`), `${JSON.stringify({
      schemaVersion: 1,
      transactionId,
      storeKey: 'DL',
      rescuePath: path.relative(ROOT, rescueFile).replaceAll(path.sep, '/'),
      rescueHash,
      runPayloadHash: env.SHEIN_BI_MARKETING_RUN_PAYLOAD_HASH,
      phase: 'desired_create_started',
      mutationsStarted: malicious.mutationsStarted ?? true,
      snapshots: [],
      ...(createAttempt ? {createAttempt} : {}),
    })}\n`);
    const maliciousArgs = [
      ...commonArgs, '--transaction-id', transactionId,
      '--out-dir', outDir, '--journal-dir', journalDir,
    ];
    const fenced = await run(maliciousArgs, env);
    assert.equal(fenced.code, 4, fenced.stderr || fenced.stdout);
    const fencedResult = parseLastJson(fenced.stdout);
    assert.equal(fencedResult.classification, 'submitted_without_exact_readback');
    assert.equal(fencedResult.readbackSkipped, true);
    assert.ok(fencedResult.journalIntegrityErrors.length > 0);
    const fencedAgain = await run(maliciousArgs, env);
    assert.equal(fencedAgain.code, 4, fencedAgain.stderr || fencedAgain.stdout);
    events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    assert.equal(events.length, 0,
      `${malicious.name} old/malicious journal must never fake empty-snapshot recovery, clear its fence, or recreate`);
  }

  await fs.writeFile(clockFile, String(baseEpoch));
  await fs.writeFile(stateFile, JSON.stringify({oldCovered: true, failDesired: true}));
  await fs.writeFile(eventsFile, '');
  const mutationArgs = [
    ...commonArgs, '--transaction-id', 'mutation-crosses-outer-continues-finalization',
    '--out-dir', path.join(temp, 'mutation-out'), '--journal-dir', path.join(temp, 'mutation-journal'),
  ];
  const crossedAfterMutation = await run(mutationArgs, env);
  assert.equal(crossedAfterMutation.code, 2, crossedAfterMutation.stderr || crossedAfterMutation.stdout);
  const mutationResult = parseLastJson(crossedAfterMutation.stdout);
  assert.equal(mutationResult.classification, 'submitted_without_exact_readback');
  assert.equal(mutationResult.safe, true, 'compensation/readback must leave exact old protection safely restored');
  events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const deleteWrite = events.findIndex(event => event.tool === 'remove' && event.execute);
  const postDeleteReadback = events.findIndex((event, index) => index > deleteWrite && event.tool === 'apply' && !event.execute && !event.compensation);
  const desiredWrite = events.findIndex((event, index) => index > deleteWrite && event.tool === 'apply' && event.execute && !event.compensation);
  const compensationWrite = events.findIndex((event, index) => index > desiredWrite && event.tool === 'apply' && event.execute && event.compensation);
  assert.ok(deleteWrite >= 0 && postDeleteReadback > deleteWrite && desiredWrite > postDeleteReadback && compensationWrite > desiredWrite,
    'a started transaction must continue post-delete readback, desired create, and compensation after outer');
  assert.ok(events[desiredWrite].epoch > outerEpoch && events[compensationWrite].epoch > outerEpoch,
    'outer is a no-new-transaction boundary, not an interruption of an already-started transaction');
  const eventCountAfterTerminalPublish = events.length;
  const resumedPending = await run(mutationArgs, env);
  assert.equal(resumedPending.code, 2, resumedPending.stderr || resumedPending.stdout);
  assert.equal(parseLastJson(resumedPending.stdout).resumedFromTerminalJournal, true,
    'same-fingerprint submitted/readback-pending journal must be terminally resumed');
  events = (await fs.readFile(eventsFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  assert.equal(events.length, eventCountAfterTerminalPublish,
    'same-fingerprint terminal pending result must not replay delete/create/compensation');

  const parentFiles = [
    'batch_restore_manual_limited_discounts.mjs',
    'batch_fix_limited_discount_drift.mjs',
    'batch_apply_new_listing_limited_discount.mjs',
  ];
  for (const parent of parentFiles) {
    const source = await fs.readFile(path.join(ROOT, 'scripts/marketing', parent), 'utf8');
    assert.match(source, /execute && ACTIVE_DEADLINE \? \[/);
    assert.match(source, /--graceful-cutoff-epoch[\s\S]*--outer-hard-deadline-epoch[\s\S]*--min-finalization-budget-sec/);
    assert.match(source, /--continuation/, `${parent} must pass continuation to the transaction child`);
  }

  const manualSource = await fs.readFile(path.join(ROOT, 'scripts/marketing/batch_restore_manual_limited_discounts.mjs'), 'utf8');
  const manual = loadResumeFunctions(manualSource, [
    'hasManualSubmittedPendingEvidence', 'normalizeManualResumeResult',
    'isManualResumeResultSettled', 'manualResultDocumentMatches',
  ]);
  const driftSource = await fs.readFile(path.join(ROOT, 'scripts/marketing/batch_fix_limited_discount_drift.mjs'), 'utf8');
  const driftSettled = value => value?.ok === true || value?.status === 'initial_platform_blocked_preserved';
  const drift = loadResumeFunctions(driftSource, [
    'hasDriftSubmittedPendingEvidence', 'normalizeDriftResumeResult', 'isDriftResumeResultSettled',
  ], {isSettledDriftRepairResult: driftSettled});
  const fallbackSource = await fs.readFile(path.join(ROOT, 'scripts/marketing/batch_apply_new_listing_limited_discount.mjs'), 'utf8');
  const fallbackSettled = value => value?.ok === true || value?.blocked?.type === 'platform_or_inventory_blocked';
  const fallback = loadResumeFunctions(fallbackSource, [
    'hasFallbackSubmittedPendingEvidence', 'normalizeFallbackResumeResult', 'isFallbackResumeResultSettled',
  ], {isResumableFallbackResult: fallbackSettled});

  for (const [name, api, submitted] of [
    ['manual', manual, {rescuePath: 'a', inventoryTransaction: {submitAttempted: true}}],
    ['drift', drift, {sourceRescuePath: 'a', transaction: {writeAttempted: true}}],
    ['fallback', fallback, {sourceRescuePath: 'a', targetSkcs: ['S1'], execute: {result: {writeAttempted: true}}}],
  ]) {
    const normalize = api[`normalize${name[0].toUpperCase()}${name.slice(1)}ResumeResult`];
    const settled = api[`is${name[0].toUpperCase()}${name.slice(1)}ResumeResultSettled`];
    assert.equal(settled({ok: true}), true, `${name} success must not replay`);
    const terminalBlocker = name === 'fallback'
      ? {blocked: {type: 'platform_or_inventory_blocked', blockedSkcs: ['S1']}}
      : name === 'drift' ? {status: 'initial_platform_blocked_preserved'} : {terminalBlocked: true};
    assert.equal(settled(terminalBlocker), true, `${name} terminal business blocker must not replay`);
    const normalized = normalize(submitted);
    assert.equal(normalized.classification, 'submitted_without_exact_readback');
    assert.equal(settled(normalized), true, `${name} submitted/readback-pending result must not replay`);
    assert.equal(settled(normalize({status: 'failed'})), false, `${name} unclear evidence must remain unsettled`);
  }
  assert.equal(manual.manualResultDocumentMatches({workFingerprint: 'same', dryRunOnly: true, results: []}, 'same', false), false,
    'same-fingerprint dry-run result must never satisfy execute resume');
  assert.equal(manual.manualResultDocumentMatches({workFingerprint: 'same', dryRunOnly: false, results: []}, 'same', false), true);

  console.log(JSON.stringify({
    ok: true,
    test: 'transaction_deadline_fenced_create_crash_malicious_journal_and_nonreplay_resume_contracts',
  }));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
