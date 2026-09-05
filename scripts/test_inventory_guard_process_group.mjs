#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInventoryGuardProcess} from '../lib/cloud_inventory_replenishment_job.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempBase = process.platform === 'linux' ? '/tmp' : path.join(ROOT, 'tmp');
await fs.mkdir(tempBase, {recursive: true});
const temp = await fs.mkdtemp(path.join(tempBase, 'guard-proc-group-'));

console.log('Starting Inventory Guard Process Group Lifecycle & Descendant Teardown tests...');

const isLinux = process.platform === 'linux';

try {
  // Test 1: Injected custom process group tester for deterministic step-up escalation to SIGKILL
  {
    let termSent = false;
    let killSent = false;
    let aliveChecks = 0;

    const mockChild = {
      pid: 12345,
      once: (event, handler) => {
        if (event === 'close') {
          setTimeout(() => handler(null, 'SIGTERM'), 60);
        }
      }
    };

    const controller = new AbortController();

    const runPromise = runInventoryGuardProcess({
      root: temp,
      env: {},
      signal: controller.signal,
      spawnProcess: () => mockChild,
      stopGraceMs: 50,
      killTimeoutMs: 200,
      pollIntervalMs: 15,
      killProcessGroup: (pgid, sig) => {
        assert.equal(pgid, 12345);
        if (sig === 'SIGTERM') termSent = true;
        if (sig === 'SIGKILL') killSent = true;
      },
      isGroupAlive: () => {
        aliveChecks += 1;
        if (!killSent) return true;
        return aliveChecks < 7;
      }
    });

    controller.abort(new Error('Test lease expired'));

    await assert.rejects(runPromise, /Test lease expired|JOB_LEASE_LOST/);
    assert.equal(termSent, true, 'SIGTERM must be sent first');
    assert.equal(killSent, true, 'SIGKILL must be escalated when descendant ignores SIGTERM');
    console.log('✓ Test 1 passed: Step-up escalation to SIGKILL when descendants ignore SIGTERM');
  }

  // Test 2: Unkillable descendant (e.g. Linux D-state) fails closed with INVENTORY_GUARD_PROCESS_GROUP_STUCK
  {
    const mockChild = {
      pid: 54321,
      once: (event, handler) => {
        if (event === 'close') {
          setTimeout(() => handler(1, null), 40);
        }
      }
    };

    const runPromise = runInventoryGuardProcess({
      root: temp,
      env: {},
      signal: new AbortController().signal,
      spawnProcess: () => mockChild,
      stopGraceMs: 30,
      killTimeoutMs: 80,
      pollIntervalMs: 15,
      killProcessGroup: () => {},
      isGroupAlive: () => true,
    });

    await assert.rejects(runPromise, err => {
      assert.equal(err.code, 'INVENTORY_GUARD_PROCESS_GROUP_STUCK');
      assert.ok(err.message.includes('D-state descendant'));
      return true;
    });
    console.log('✓ Test 2 passed: D-state descendant fails closed and does not allow retry');
  }

  // Test 3, 4, 5: Real POSIX process group teardown on Linux
  if (isLinux) {
    const descendantScript = path.join(temp, 'descendant.mjs');
    const guardBashScript = path.join(temp, 'guard_mock.sh');
    const heartbeatLog = path.join(temp, 'descendant_heartbeat.log');
    const pidFile = path.join(temp, 'descendant.pid');

    const descendantCode = [
      'import fs from "node:fs";',
      'fs.writeFileSync("' + heartbeatLog + '", "STARTED" + String.fromCharCode(10));',
      'process.on("SIGTERM", () => {',
      '  try { fs.appendFileSync("' + heartbeatLog + '", "IGNORED_SIGTERM" + String.fromCharCode(10)); } catch {}',
      '});',
      'setInterval(() => {',
      '  try { fs.appendFileSync("' + heartbeatLog + '", "BEAT" + String.fromCharCode(10)); } catch {}',
      '}, 20);'
    ].join('\n');
    await fs.writeFile(descendantScript, descendantCode, 'utf8');

    const guardBashCode = [
      '#!/usr/bin/env bash',
      process.execPath + ' "' + descendantScript + '" &',
      'echo $! > "' + pidFile + '"',
      'wait'
    ].join('\n');
    await fs.writeFile(guardBashScript, guardBashCode, {mode: 0o755});

    const controller = new AbortController();
    (async () => {
      for (let i = 0; i < 150; i++) {
        if (fsSync.existsSync(heartbeatLog) && fsSync.existsSync(pidFile)) break;
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 50));
      controller.abort(new Error('Simulated lease lost'));
    })();

    let thrown = null;
    try {
      await runInventoryGuardProcess({
        root: temp,
        env: process.env,
        signal: controller.signal,
        scriptPath: guardBashScript,
        stopGraceMs: 60,
        killTimeoutMs: 1000,
        pollIntervalMs: 20,
      });
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, 'Must reject on abort');

    const descPid = parseInt(fsSync.readFileSync(pidFile, 'utf8').trim(), 10);
    let descAlive = true;
    try {
      process.kill(descPid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') descAlive = false;
    }
    assert.equal(descAlive, false, 'Descendant must be confirmed dead (ESRCH)');

    const log = fsSync.readFileSync(heartbeatLog, 'utf8');
    assert.ok(log.includes('IGNORED_SIGTERM'), 'Descendant must receive and ignore SIGTERM before SIGKILL');
    console.log('✓ Test 3 passed: Real POSIX process group confirmed dead under Linux (SIGTERM ignored, killed via SIGKILL)');

    // Test 4: Real Linux - Parent bash exits early leaving background descendant
    const parentExitsEarlyBash = path.join(temp, 'parent_exits.sh');
    const orphanPidFile = path.join(temp, 'orphan.pid');
    const orphanHeartbeat = path.join(temp, 'orphan_beat.log');

    const orphanScript = path.join(temp, 'orphan.mjs');
    await fs.writeFile(orphanScript, 'setInterval(() => {}, 20);\n', 'utf8');

    const parentExitsBashCode = [
      '#!/usr/bin/env bash',
      process.execPath + ' "' + orphanScript + '" &',
      'echo $! > "' + orphanPidFile + '"',
      'exit 0'
    ].join('\n');
    await fs.writeFile(parentExitsEarlyBash, parentExitsBashCode, {mode: 0o755});

    await runInventoryGuardProcess({
      root: temp,
      env: process.env,
      signal: new AbortController().signal,
      scriptPath: parentExitsEarlyBash,
      stopGraceMs: 50,
      killTimeoutMs: 1000,
      pollIntervalMs: 20,
    });

    const orphanPid = parseInt(fsSync.readFileSync(orphanPidFile, 'utf8').trim(), 10);
    let orphanAlive = true;
    try {
      process.kill(orphanPid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') orphanAlive = false;
    }
    assert.equal(orphanAlive, false, 'Orphan descendant must be terminated even when parent exited early');
    console.log('✓ Test 4 passed: Orphan descendants terminated and confirmed dead when parent exits early');

    // Test 5: Real Linux - Defunct Zombie (Z) process in group does NOT cause false STUCK
    const zombieBashScript = path.join(temp, 'zombie_guard.sh');
    const zombieBashCode = [
      '#!/usr/bin/env bash',
      process.execPath + ' -e "process.exit(0)" &',
      'sleep 0.1',
      'exit 0'
    ].join('\n');
    await fs.writeFile(zombieBashScript, zombieBashCode, {mode: 0o755});

    const startT = performance.now();
    await runInventoryGuardProcess({
      root: temp,
      env: process.env,
      signal: new AbortController().signal,
      scriptPath: zombieBashScript,
      stopGraceMs: 50,
      killTimeoutMs: 500,
      pollIntervalMs: 15,
    });
    const elapsed = performance.now() - startT;
    assert.ok(elapsed < 1000, 'Zombie process must not cause timeout/hang, took ' + elapsed + 'ms');
    console.log('✓ Test 5 passed: Defunct Zombie (Z) descendants correctly recognized and do not cause false STUCK');
  } else {
    let groupKilled = false;
    let descAlive = true;

    const mockChild = {
      pid: 8888,
      once: (event, handler) => {
        if (event === 'close') {
          setTimeout(() => handler(0, null), 30);
        }
      }
    };

    await runInventoryGuardProcess({
      root: temp,
      env: {},
      signal: new AbortController().signal,
      spawnProcess: () => mockChild,
      stopGraceMs: 40,
      killTimeoutMs: 150,
      pollIntervalMs: 15,
      killProcessGroup: (pgid, sig) => {
        assert.equal(pgid, 8888);
        if (sig === 'SIGKILL' || sig === 'SIGTERM') {
          groupKilled = true;
          descAlive = false;
        }
      },
      isGroupAlive: () => descAlive,
    });

    assert.equal(groupKilled, true);
    assert.equal(descAlive, false);
    console.log('✓ Test 3 & 4 passed (Windows host simulated): Parent exit 0 terminates active orphan process group');
  }

  // Test 6: Guard execution timeout triggers process group termination
  {
    let killCalled = false;
    const mockChild = {
      pid: 9999,
      once: () => {},
    };

    const runPromise = runInventoryGuardProcess({
      root: temp,
      env: {},
      signal: new AbortController().signal,
      spawnProcess: () => mockChild,
      timeoutMs: 60,
      stopGraceMs: 30,
      killTimeoutMs: 100,
      pollIntervalMs: 15,
      killProcessGroup: (pgid, sig) => {
        killCalled = true;
      },
      isGroupAlive: () => false,
    });

    await assert.rejects(runPromise, err => {
      assert.equal(err.code, 'INVENTORY_GUARD_TIMEOUT');
      return true;
    });
    assert.equal(killCalled, true, 'Timeout must trigger kill to process group');
    console.log('✓ Test 6 passed: Run deadline timeout triggers process group teardown and rejects');
  }

  // Test 7: Shared single cleanupPromise prevents duplicate or overlapping teardown cycles
  {
    let termCalls = 0;
    let killCalls = 0;
    let closeCb = null;

    const mockChild = {
      pid: 7777,
      once: (event, handler) => {
        if (event === 'close') closeCb = handler;
      }
    };

    const controller = new AbortController();
    const runPromise = runInventoryGuardProcess({
      root: temp,
      env: {},
      signal: controller.signal,
      spawnProcess: () => mockChild,
      stopGraceMs: 50,
      killTimeoutMs: 100,
      pollIntervalMs: 15,
      killProcessGroup: (pgid, sig) => {
        if (sig === 'SIGTERM') termCalls += 1;
        if (sig === 'SIGKILL') killCalls += 1;
      },
      isGroupAlive: () => false,
    });

    // Simultaneously trigger abort (stop) and child close (finish)
    controller.abort(new Error('Simultaneous abort'));
    if (closeCb) closeCb(1, null);

    await assert.rejects(runPromise);
    assert.equal(termCalls, 1, 'Only one SIGTERM must be dispatched across concurrent stop & finish');
    assert.equal(killCalls, 0, 'No kill needed when alive returns false');
    console.log('✓ Test 7 passed: Single shared cleanupPromise strictly prevents concurrent or duplicate teardown');
  }

  console.log('All Inventory Guard Process Group tests passed successfully!');
} finally {
  await fs.rm(temp, {recursive: true, force: true}).catch(() => {});
}
