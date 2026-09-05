#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {
  readProcStat,
  scanLinuxProcessTree,
  checkProcessAlive,
  cleanupProcessTree,
  runLarkCommand,
  deliverCloudTeamReport,
} from '../lib/cloud_team_report_cloud.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = path.join(ROOT, 'tmp', 'proc-lifecycle-' + crypto.randomBytes(6).toString('hex'));
await fs.mkdir(tempDir, {recursive: true});

console.log('Starting Cloud Team Report Process Lifecycle & Process Tree Teardown tests...');
console.log('Platform:', process.platform, 'tempDir:', tempDir);

// -------------------------------------------------------------
// Group 1: Unit tests with simulation & FS error injection
// -------------------------------------------------------------
console.log('\n--- Group 1: Unit tests with simulation & FS error injection ---');

const mockProcEmpty = { readdirSync: () => [], readFileSync: () => '' };
// 1.1 Simulated PID reuse: when a PID is recorded with birthtime A, but now has birthtime B, it must NOT be killed or considered alive
{
  const killedPids = [];
  const fakeBirthtimes = new Map([[9999, '100000']]);

  const isAliveFn = (pid, expectedBirthtime) => {
    if (pid === 9999 && expectedBirthtime !== '200000') {
      return false;
    }
    return true;
  };

  const killFn = (pid, sig) => {
    killedPids.push({pid, sig});
  };

  const res = await cleanupProcessTree({
    child: {pid: 9999},
    trackedPids: new Set([9999]),
    knownBirthtimes: fakeBirthtimes,
    graceMs: 50,
    killTimeoutMs: 100,
    pollIntervalMs: 10,
    isAliveFn,
    killFn,
    platform: 'linux',
    fsImpl: mockProcEmpty,
  });

  assert.equal(res.ok, true, 'Reused PID must not cause cleanup failure');
  assert.equal(killedPids.length, 0, 'Reused PID must NEVER be signaled or killed');
  console.log('[simulated] PID reuse protection verified: reused PID is untouched');
}

// 1.2 Simulated unkillable descendant (e.g. D-state / EPERM where process remains alive): returns ok=false, non-retryable
{
  const killedSignals = [];
  let aliveChecks = 0;

  const res = await cleanupProcessTree({
    child: {pid: 8888},
    trackedPids: new Set([8888]),
    knownBirthtimes: new Map([[8888, '123456']]),
    graceMs: 40,
    killTimeoutMs: 120,
    pollIntervalMs: 15,
    fsImpl: mockProcEmpty,
    isAliveFn: (pid) => {
      aliveChecks += 1;
      return true;
    },
    killFn: (pid, sig) => {
      killedSignals.push(sig);
    },
    platform: 'linux',
  });

  assert.equal(res.ok, false, 'Unkillable descendant must report cleanup failure');
  assert.deepEqual(res.alivePids, [8888], 'Alive PID must be reported');
  assert.ok(killedSignals.includes('SIGTERM'), 'Must have tried SIGTERM');
  assert.ok(killedSignals.includes('SIGKILL'), 'Must have escalated to SIGKILL');
  console.log('[simulated] Unkillable/D-state descendant returns ok=false with target PID and non-retryable unknown');
}

// 1.3 Simulated step-up escalation from SIGTERM to SIGKILL
{
  const signalsSent = [];
  let sigkillReceived = false;

  const res = await cleanupProcessTree({
    child: {pid: 7777},
    trackedPids: new Set([7777]),
    knownBirthtimes: new Map([[7777, '555555']]),
    graceMs: 60,
    killTimeoutMs: 200,
    pollIntervalMs: 15,
    fsImpl: mockProcEmpty,
    isAliveFn: () => {
      return !sigkillReceived;
    },
    killFn: (pid, sig) => {
      signalsSent.push(sig);
      if (sig === 'SIGKILL') sigkillReceived = true;
    },
    platform: 'linux',
  });

  assert.equal(res.ok, true);
  assert.equal(signalsSent[0], 'SIGTERM', 'First signal must be SIGTERM');
  assert.ok(signalsSent.includes('SIGKILL'), 'Must escalate to SIGKILL');
  console.log('[simulated] Step-up escalation: SIGTERM sent first, escalated to SIGKILL when TERM ignored');
}

// 1.4 Real injected FS error path (fail-closed check on EACCES / EPERM)
{
  // Mock fsImpl where /proc/<pid>/stat throws EACCES
  const mockFsEacces = {
    readFileSync: (filepath) => {
      const err = new Error('Permission denied');
      err.code = 'EACCES';
      throw err;
    },
    readdirSync: () => ['1234'],
  };

  // When readProcStat encounters EACCES, it returns {error} rather than null
  const statRes = readProcStat('1234', {fsImpl: mockFsEacces, platform: 'linux'});
  assert.ok(statRes && statRes.error, 'readProcStat must return error object on EACCES');
  assert.equal(statRes.error.code, 'EACCES');

  // checkProcessAlive on EACCES must FAIL CLOSED (return true / alive / unverified)
  const aliveUnderEacces = checkProcessAlive(1234, '1000', null, {fsImpl: mockFsEacces, platform: 'linux'});
  assert.equal(aliveUnderEacces, true, 'Fail closed: unreadable proc stat must NOT be assumed dead');

  // In cleanupProcessTree with injected EACCES, cleanup must fail closed (ok=false)
  const cleanupWithEacces = await cleanupProcessTree({
    child: {pid: 1234},
    trackedPids: new Set([1234]),
    graceMs: 30,
    killTimeoutMs: 80,
    pollIntervalMs: 15,
    fsImpl: mockFsEacces,
    platform: 'linux',
    killFn: () => {},
  });
  assert.equal(cleanupWithEacces.ok, false, 'Cleanup must report ok=false when fs inspection errors');
  assert.equal(cleanupWithEacces.unverified, true, 'Cleanup must report unverified status');
  console.log('[simulated] Injected FS EACCES error: fails closed, never assumes dead');
}

// 1.4b Injected malformed stat line: idx === -1 must fail closed as unverified/alive
{
  const mockFsMalformed = {
    readFileSync: () => 'malformed content without closing paren',
    readdirSync: () => ['1234'],
  };

  const statRes = readProcStat('1234', {fsImpl: mockFsMalformed, platform: 'linux'});
  assert.ok(statRes && statRes.error, 'Malformed stat must return error object');
  assert.match(statRes.error.message, /malformed procfs stat/);

  const aliveOnMalformed = checkProcessAlive(1234, '1000', null, {fsImpl: mockFsMalformed, platform: 'linux'});
  assert.equal(aliveOnMalformed, true, 'Fail closed: malformed proc stat must NOT be assumed dead');
  console.log('[simulated] Injected malformed procfs stat: fails closed as unverified/alive');
}

// 1.7 Windows taskkill exitCode 128 (root already closed before taskkill): fails closed as unverified=true, ok=false
{
  const calls = [];
  const mockRunner128 = async (args) => {
    calls.push(args);
    // Taskkill returns exitCode 128 when process is not found
    return { ok: false, exitCode: 128 };
  };

  const res = await cleanupProcessTree({
    child: {pid: 4444},
    trackedPids: new Set([4444]),
    platform: 'win32',
    taskkillRunner: mockRunner128,
    isAliveFn: () => false, // root PID is not alive in process table
    killTimeoutMs: 100,
    pollIntervalMs: 15,
  });

  assert.equal(res.ok, false, 'Windows: root taskkill 128 must NOT be reported as ok=true');
  assert.equal(res.unverified, true, 'Windows: root taskkill 128 must report unverified=true');
  console.log('[simulated] Windows taskkill exitCode 128: fails closed with ok=false, unverified=true');
}

// 1.8 Windows taskkill non-zero exit code / failure: fails closed as unverified=true, ok=false
{
  const mockRunnerErr = async () => ({ ok: false, exitCode: 1 });

  const res = await cleanupProcessTree({
    child: {pid: 5555},
    trackedPids: new Set([5555]),
    platform: 'win32',
    taskkillRunner: mockRunnerErr,
    isAliveFn: () => false,
    killTimeoutMs: 100,
    pollIntervalMs: 15,
  });

  assert.equal(res.ok, false, 'Windows: non-zero taskkill must fail closed');
  assert.equal(res.unverified, true, 'Windows: non-zero taskkill must be unverified');
  console.log('[simulated] Windows taskkill error/non-zero: fails closed with ok=false, unverified=true');
}

// 1.9 Windows taskkill hanging / timeout: fails closed as unverified=true, ok=false
{
  const mockRunnerTimeout = async () => ({ ok: false, timedOut: true });

  const res = await cleanupProcessTree({
    child: {pid: 6666},
    trackedPids: new Set([6666]),
    platform: 'win32',
    taskkillRunner: mockRunnerTimeout,
    isAliveFn: () => false,
    killTimeoutMs: 100,
    pollIntervalMs: 15,
  });

  assert.equal(res.ok, false, 'Windows: taskkill timeout must fail closed');
  assert.equal(res.unverified, true, 'Windows: taskkill timeout must be unverified');
  console.log('[simulated] Windows taskkill timeout: fails closed with ok=false, unverified=true');
}

// 1.5 Real injected /proc readdirSync error
{
  const mockFsReaddirErr = {
    readFileSync: () => '',
    readdirSync: () => {
      const err = new Error('I/O error');
      err.code = 'EIO';
      throw err;
    },
  };

  const scanRes = scanLinuxProcessTree([1234], new Map(), {fsImpl: mockFsReaddirErr, platform: 'linux'});
  assert.equal(scanRes.unverified, true, 'scanLinuxProcessTree must fail closed if /proc readdir fails');
  console.log('[simulated] Injected /proc readdir EIO error: fails closed with unverified=true');
}

// 1.6 Abort signal race: signal aborted immediately after child spawn
{
  const abortController = new AbortController();
  const promise = runLarkCommand({
    spawnImpl: (bin, args, options) => {
      // Simulate spawn where abort happens concurrently
      abortController.abort();
      return {
        pid: 99999,
        stdout: { setEncoding: () => {}, on: () => {} },
        stderr: { setEncoding: () => {}, on: () => {} },
        on: (ev, cb) => {
          if (ev === 'close') setTimeout(() => cb(-1), 50);
        },
      };
    },
    args: [],
    signal: abortController.signal,
  });

  const raw = await promise;
  assert.equal(raw.aborted, true, 'Immediate abort signal race must be cleanly captured');
  console.log('[simulated] Signal race immediately after spawn: captured without hanging');
}

// -------------------------------------------------------------
// Group 2: Real OS process tree teardown tests
// -------------------------------------------------------------
console.log('\n--- Group 2: Real OS process tree teardown tests ---');

// 2.1 Normal parent close orphan: parent exits cleanly with code 0, but leaves a running grandchild
{
  const canaryFile = path.join(tempDir, 'orphan_canary.txt');
  const grandchildScript = path.join(tempDir, 'orphan_grandchild.mjs');
  const parentScript = path.join(tempDir, 'orphan_parent.mjs');

  const gcSrc = 'import fs from "node:fs";\n' +
    'const file = process.argv[2];\n' +
    'fs.appendFileSync(file, "grandchild_running\\n");\n' +
    'setTimeout(() => {\n' +
    '  try { fs.appendFileSync(file, "grandchild_leak_completed\\n"); } catch {}\n' +
    '  process.exit(0);\n' +
    '}, 1200);\n';
  await fs.writeFile(grandchildScript, gcSrc, 'utf8');

  const parentSrc = 'import {spawn} from "node:child_process";\n' +
    'import fs from "node:fs";\n' +
    'const [,, gcScript, file] = process.argv;\n' +
    'const child = spawn(process.execPath, [gcScript, file], {\n' +
    '  stdio: "ignore",\n' +
    '  detached: process.platform !== "win32",\n' +
    '});\n' +
    'child.unref();\n' +
    'const start = Date.now();\n' +
    'while (Date.now() - start < 2000) {\n' +
    '  try {\n' +
    '    if (fs.readFileSync(file, "utf8").includes("grandchild_running")) break;\n' +
    '  } catch {}\n' +
    '}\n' +
    'process.exit(0);\n';
  await fs.writeFile(parentScript, parentSrc, 'utf8');

  const raw = await runLarkCommand({
    spawnImpl: (bin, args, options) => {
      return spawn(process.execPath, [parentScript, grandchildScript, canaryFile], options);
    },
    args: [],
    timeoutMs: 5000,
  });

  assert.equal(raw.exitCode, 0, 'Parent exited with 0');
  await new Promise(r => setTimeout(r, 1500));
  const canaryContent = await fs.readFile(canaryFile, 'utf8').catch(() => '');
  assert.match(canaryContent, /grandchild_running/, 'Grandchild was spawned');
  assert.doesNotMatch(canaryContent, /grandchild_leak_completed/, 'Orphan grandchild MUST be reaped upon parent close');
  console.log('[real] Normal parent close orphan reaped: no late leak after normal parent exit');
}

// 2.2 Parent-before-child close race: wrapper dies before child finishes spawning / writing
{
  const canaryFile = path.join(tempDir, 'race_canary.txt');
  const childScript = path.join(tempDir, 'race_child.mjs');
  const parentScript = path.join(tempDir, 'race_parent.mjs');

  const childSrc = 'import fs from "node:fs";\n' +
    'const file = process.argv[2];\n' +
    'fs.appendFileSync(file, "child_alive\\n");\n' +
    'setTimeout(() => {\n' +
    '  try { fs.appendFileSync(file, "child_late\\n"); } catch {}\n' +
    '  process.exit(0);\n' +
    '}, 1000);\n';
  await fs.writeFile(childScript, childSrc, 'utf8');

  const parentSrc = 'import {spawn} from "node:child_process";\n' +
    'const [,, cScript, file] = process.argv;\n' +
    'const child = spawn(process.execPath, [cScript, file], {\n' +
    '  stdio: "ignore",\n' +
    '  detached: process.platform !== "win32",\n' +
    '});\n' +
    'child.unref();\n' +
    'setTimeout(() => process.exit(0), 40);\n';
  await fs.writeFile(parentScript, parentSrc, 'utf8');

  const raw = await runLarkCommand({
    spawnImpl: (bin, args, options) => {
      return spawn(process.execPath, [parentScript, childScript, canaryFile], options);
    },
    args: [],
    timeoutMs: 4000,
  });

  await new Promise(r => setTimeout(r, 1300));
  const canaryContent = await fs.readFile(canaryFile, 'utf8').catch(() => '');
  assert.doesNotMatch(canaryContent, /child_late/, 'Descendant reaped cleanly even if parent closed immediately');
  console.log('[real] Parent-before-child close race handled: all descendants reaped');
}

// 2.3 Timeout path with SIGKILL readback
{
  const canaryFile = path.join(tempDir, 'timeout_canary.txt');
  const hungScript = path.join(tempDir, 'hung_proc.mjs');

  const hungSrc = 'import fs from "node:fs";\n' +
    'const file = process.argv[2];\n' +
    'fs.appendFileSync(file, "hung_started\\n");\n' +
    'setInterval(() => {\n' +
    '  try { fs.appendFileSync(file, "hung_tick\\n"); } catch {}\n' +
    '}, 200);\n';
  await fs.writeFile(hungScript, hungSrc, 'utf8');

  const raw = await runLarkCommand({
    spawnImpl: (bin, args, options) => {
      return spawn(process.execPath, [hungScript, canaryFile], options);
    },
    args: [],
    timeoutMs: 400,
  });

  assert.equal(raw.timedOut, true, 'Command must report timedOut');
  assert.equal(raw.killed, true, 'Command must report killed');

  const initialCanary = await fs.readFile(canaryFile, 'utf8').catch(() => '');
  await new Promise(r => setTimeout(r, 800));
  const finalCanary = await fs.readFile(canaryFile, 'utf8').catch(() => '');

  assert.equal(initialCanary, finalCanary, 'No further ticks after timeout and kill readback');
  console.log('[real] Timeout path verified: process killed and readback confirmed terminated');
}

// 2.4 POSIX SIGTERM-resistant descendant
{
  const canaryFile = path.join(tempDir, 'resistant_canary.txt');
  const resistantScript = path.join(tempDir, 'resistant_proc.mjs');

  const resSrc = 'import fs from "node:fs";\n' +
    'const file = process.argv[2];\n' +
    'fs.appendFileSync(file, "resistant_started\\n");\n' +
    'if (process.platform !== "win32") {\n' +
    '  process.on("SIGTERM", () => {\n' +
    '    try { fs.appendFileSync(file, "ignored_sigterm\\n"); } catch {}\n' +
    '  });\n' +
    '}\n' +
    'setTimeout(() => {\n' +
    '  try { fs.appendFileSync(file, "resistant_late_finished\\n"); } catch {}\n' +
    '  process.exit(0);\n' +
    '}, 2000);\n';
  await fs.writeFile(resistantScript, resSrc, 'utf8');

  const abortController = new AbortController();
  const promise = runLarkCommand({
    spawnImpl: (bin, args, options) => {
      return spawn(process.execPath, [resistantScript, canaryFile], options);
    },
    args: [],
    signal: abortController.signal,
    timeoutMs: 5000,
  });

  let canary = '';
  for (let i = 0; i < 40; i++) {
    canary = await fs.readFile(canaryFile, 'utf8').catch(() => '');
    if (canary.includes('resistant_started')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.match(canary, /resistant_started/);

  abortController.abort();
  const raw = await promise;
  assert.equal(raw.aborted, true);

  await new Promise(r => setTimeout(r, 2200));
  const finalCanary = await fs.readFile(canaryFile, 'utf8').catch(() => '');
  assert.doesNotMatch(finalCanary, /resistant_late_finished/, 'Process must be terminated before late finished');
  console.log('[real] SIGTERM-resistant / abort teardown verified: no late completion');
}

await fs.rm(tempDir, {recursive: true, force: true});
console.log('All Cloud Team Report process lifecycle and process tree teardown tests passed!');
