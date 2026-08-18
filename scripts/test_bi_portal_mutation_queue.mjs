#!/usr/bin/env node
// Bounded Portal mutation-queue lifecycle acceptance (integration).
//
// Against the real spawned Portal (never CI/runner changes):
// - both runtimes register SIGTERM/SIGINT before listen and admission is
//   closed by default until every component starts (startup latch);
// - a startup failure (listen EADDRINUSE) goes through unified shutdown and
//   exits non-zero;
// - mutation-queue bounded capacity rejects the capacity+1 request with 429;
// - a queued-but-not-started mutation that drops through its queue deadline
//   is rejected with 429 and never executed;
// - SIGTERM cancels queued-but-not-started mutations with 503 while the
//   already-started mutation drains exactly once and the process exits 0.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {provisionBiSessionSecret} from './provision_bi_session_secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-mutation-queue-'));
const portalDir = path.join(temp, 'portal');
await fs.mkdir(path.join(portalDir, 'sections'), {recursive: true});
await fs.writeFile(path.join(portalDir, 'index.html'), '<!doctype html><title>fixture</title>', 'utf8');
await fs.writeFile(path.join(portalDir, 'data.json'), JSON.stringify({
  generatedAt: '2026-08-18T00:00:00.000+08:00',
  dates: {salesDate: '2026-08-18', salesUpdatedAt: '2026-08-18T00:00:00.000+08:00'},
  stores: [{store_key: 'HL', label: 'HL 店'}],
  __sections: {mode: 'api', generatedAt: '2026-08-18T00:00:00.000+08:00', keys: [], loaded: ['core']},
}), 'utf8');
const authFile = path.join(temp, 'users.json');
await fs.writeFile(authFile, JSON.stringify({users: [{username: 'mutation-test', password: 'correct-password', role: 'admin'}]}), 'utf8');
const sessionSecretFile = path.join(temp, 'session-secret');
await provisionBiSessionSecret(sessionSecretFile);
const shutdownTrigger = path.join(temp, 'shutdown-trigger');

const baseArgs = [
  '--host', '127.0.0.1',
  '--dir', portalDir,
  '--auth-file', authFile,
  '--htpasswd-file', path.join(temp, 'missing.htpasswd'),
  '--session-secret-file', sessionSecretFile,
  '--session-ttl-days', '90',
  '--state-file', path.join(temp, 'state.json'),
  '--link-ops-task-file', path.join(temp, 'tasks.json'),
  '--link-ops-chat-file', path.join(temp, 'chats.json'),
  '--link-ops-runtime-file', path.join(temp, 'runtime.json'),
  '--manual-login-state-file', path.join(temp, 'manual-login.json'),
  '--audit-file', path.join(temp, 'audit.jsonl'),
];
const baseEnv = {
  ...process.env,
  SHEIN_LINK_OPS_STORE: 'json',
  SHEIN_WEBHOOK_REPOSITORY_ENABLED: '0',
  SHEIN_BI_CORE_WARMUP_DISABLED: '1',
  SHEIN_BI_INTENT_PLANNER_ENABLED: '0',
  SHEIN_BI_JOB_WORKER_ENABLED: '0',
  SHEIN_BI_EXTERNAL_SECTION_QUEUE_ENABLED: '0',
  SHEIN_OWNER_KNOWLEDGE_GIT_REPO_DIR: '',
};

const children = new Set();

try {
  // 1. Static invariants: both runtimes register SIGTERM/SIGINT before
  //    server.listen, the queue is created bounded in both surfaces, and the
  //    portal maps saturation/deadline to 429 and shutdown to 503.
  {
    const source = await fs.readFile(path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'), 'utf8');
    const indicesOf = (text, needle) => {
      const out = [];
      let idx = text.indexOf(needle);
      while (idx !== -1) { out.push(idx); idx = text.indexOf(needle, idx + 1); }
      return out;
    };
    const sigterm = indicesOf(source, "process.once('SIGTERM',");
    const sigint = indicesOf(source, "process.once('SIGINT',");
    const listens = indicesOf(source, 'server.listen(args.port, args.host, resolve)');
    assert.equal(sigterm.length, 2, 'both runtimes must register SIGTERM');
    assert.equal(sigint.length, 2, 'both runtimes must register SIGINT');
    assert.equal(listens.length, 2, 'both runtimes must listen');
    assert.ok(sigterm[0] < listens[0] && sigterm[1] < listens[1],
      'SIGTERM must be registered before server.listen in both runtimes');
    assert.ok(sigint[0] < listens[0] && sigint[1] < listens[1],
      'SIGINT must be registered before server.listen in both runtimes');
    assert.ok(source.includes('createSerialMutationQueue({'),
      'both surfaces must create the queue with an explicit bounded configuration');
    assert.ok(source.includes('BI_MUTATION_QUEUE_SATURATED'), 'portal must map queue saturation to 429');
    assert.ok(source.includes('BI_MUTATION_QUEUE_SHUTTING_DOWN'), 'portal must map queue shutdown to 503');
  }

  // 2. Startup-failure counterexample: an EADDRINUSE listen failure must go
  //    through unified shutdown and exit non-zero (never keep serving).
  {
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const blockedPort = blocker.address().port;
    const failed = spawnRuntime(blockedPort, [], {});
    await waitForExit(failed, 25_000);
    assert.notEqual(failed.child.exitCode, 0, 'a listen failure must exit non-zero');
    assert.match(failed.stdout + '\\n' + failed.stderr, /startup-failure/,
      'a listen failure must log the startup-failure event');
    await new Promise(resolve => blocker.close(resolve));
  }

  // 3. Bounded capacity (capacity+1) -> 429 while the first mutation holds.
  {
    const port = await freePort();
    const runtime = spawnRuntime(port, [], {
      SHEIN_BI_MUTATION_QUEUE_CAPACITY: '1',
      SHEIN_BI_MUTATION_TEST_HOLD_MS: '800',
      SHEIN_BI_MUTATION_TEST_HOLD_FOR: 'hold1',
    });
    await waitReady(runtime, port, '/api/health');
    const first = postJson(port, '/api/logout?hold=hold1', {});
    await sleep(80);               // first mutation admitted and holding
    const second = postJson(port, '/api/logout', {});
    await sleep(60);               // second is queued (1 running + 1 queued)
    const third = await postJson(port, '/api/logout', {});
    assert.equal(third.status, 429,
      `the capacity+1 mutation must be rejected with 429: ${JSON.stringify(third)}`);
    assert.equal(third.body?.code, 'BI_MUTATION_QUEUE_SATURATED', JSON.stringify(third.body));
    assert.equal((await first).status, 200, 'the admitted held mutation must complete');
    assert.equal((await second).status, 200, 'the exactly-admitted queued mutation must run');
    const health = await getJson(port, '/api/health');
    assert.equal(health.body?.mutationQueue?.queued, 0, 'the queue must drain');
    assert.ok(Number(health.body?.mutationQueue?.rejected?.saturated) >= 1,
      'health must expose the saturated counter');
    await stopRuntime(runtime);
  }

  // 4. Queue deadline: a queued-but-not-started mutation that waits past its
  //    deadline is rejected with 429 and never executed; the running mutation
  //    is not killed by the deadline.
  {
    const port = await freePort();
    const runtime = spawnRuntime(port, [], {
      SHEIN_BI_MUTATION_QUEUE_CAPACITY: '2',
      SHEIN_BI_MUTATION_QUEUE_DEADLINE_MS: '250',
      SHEIN_BI_MUTATION_TEST_HOLD_MS: '1000',
      SHEIN_BI_MUTATION_TEST_HOLD_FOR: 'hold2',
    });
    await waitReady(runtime, port, '/api/health');
    const held = postJson(port, '/api/logout?hold=hold2', {});
    await sleep(80);
    const queuedTimeout = await postJson(port, '/api/logout', {});
    assert.equal(queuedTimeout.status, 429,
      `a queued mutation past its deadline must be 429: ${JSON.stringify(queuedTimeout.body)}`);
    assert.equal(queuedTimeout.body?.code, 'BI_MUTATION_QUEUE_DEADLINE_EXCEEDED',
      JSON.stringify(queuedTimeout.body));
    assert.equal((await held).status, 200, 'the running mutation must not be killed by the queue deadline');
    const health = await getJson(port, '/api/health');
    assert.ok(Number(health.body?.mutationQueue?.rejected?.deadlineExceeded) >= 1,
      'health must expose the deadline-exceeded counter');
    await stopRuntime(runtime);
  }

  // 5. SIGTERM cancels queued-but-not-started mutations with 503; the
  //    already-started mutation drains exactly once; the process exits 0.
  {
    const port = await freePort();
    const runtime = spawnRuntime(port, [], {
      SHEIN_BI_MUTATION_QUEUE_CAPACITY: '2',
      SHEIN_BI_MUTATION_TEST_HOLD_MS: '2000',
      SHEIN_BI_MUTATION_TEST_HOLD_FOR: 'hold5',
      SHEIN_BI_PORTAL_SHUTDOWN_TIMEOUT_MS: '10000',
      SHEIN_BI_TEST_SHUTDOWN_FILE: shutdownTrigger,
    });
    await waitReady(runtime, port, '/api/health');
    const held = postJson(port, '/api/logout?hold=hold5', {});
    await sleep(120);
    const queued = postJson(port, '/api/logout', {});
    // Wait until health proves the queue actually holds the second mutation
    // before signalling shutdown, so the 503 path is exercised deterministically.
    await waitForHealth(port, (st) => st.running >= 1 && st.queued >= 1);
    // Drive the exact production unified-shutdown path. A real SIGTERM is
    // delivered by systemd on Linux; a Windows test process cannot deliver a
    // catchable POSIX signal to a spawned child, so the env-gated trigger file
    // invokes the same handleShutdownSignal/shutdownHttpRuntime sequence.
    await fs.writeFile(shutdownTrigger, '1');
    const queuedResult = await queued;
    const heldResult = await held;
    assert.equal(queuedResult.status, 503,
      `a queued-but-not-started mutation must be 503 on SIGTERM: ${JSON.stringify(queuedResult)}`);
    assert.equal(queuedResult.body?.code, 'BI_MUTATION_QUEUE_SHUTTING_DOWN',
      JSON.stringify(queuedResult.body));
    assert.equal(heldResult.status, 200,
      `the already-started mutation must drain exactly once: ${JSON.stringify(heldResult)}`);
    const exitCode = await waitForExit(runtime, 25_000);
    assert.equal(exitCode, 0,
      `graceful SIGTERM shutdown must exit 0 (got ${exitCode}); stderr=${runtime.stderr}`);
    const postShutdown = await postJson(port, '/api/logout', {}).catch(error => ({status: 0, error: String(error)}));
    assert.notEqual(postShutdown.status, 200, 'a mutation after shutdown must not be admitted');
  }

  // 6. The query surface exposes the same bounded-queue/runtime health and
  //    opens admission only after startup.
  {
    const port = await freePort();
    const runtime = spawnRuntime(port, ['--surface', 'query',
      '--link-ops-task-file', path.join(temp, 'query-tasks.json'),
      '--link-ops-chat-file', path.join(temp, 'query-chats.json'),
      '--link-ops-runtime-file', path.join(temp, 'query-runtime.json'),
    ], {});
    await waitReady(runtime, port, '/api/health');
    const health = await getJson(port, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body?.runtime?.admissionOpened, true,
      'the query surface must open admission only after startup completes');
    assert.equal(health.body?.runtime?.accepting, true);
    assert.ok(Number(health.body?.mutationQueue?.capacity) >= 1,
      'the query surface must expose the bounded queue capacity');
    await stopRuntime(runtime);
  }

  console.log(JSON.stringify({
    ok: true,
    service: 'shein-bi-portal',
    signalsBeforeListen: true,
    startupFailureUnifiedShutdown: true,
    capacityPlusOne429: true,
    queueDeadline429: true,
    shutdownQueued503: true,
    startedMutationDrainedOnce: true,
    querySurfaceLatchOpened: true,
  }, null, 2));
} finally {
  for (const runtime of children) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGKILL');
  }
  await fs.rm(temp, {recursive: true, force: true});
}

function spawnRuntime(port, extraArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [
    path.join(ROOT, 'scripts', 'serve_bi_portal.mjs'),
    '--port', String(port),
    ...baseArgs,
    ...extraArgs,
  ], {cwd: ROOT, env: {...baseEnv, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe']});
  const runtime = {child, stdout: '', stderr: ''};
  child.stdout.on('data', chunk => {
    runtime.stdout += chunk.toString('utf8');
    process.stderr.write('[child:out] ' + chunk.toString('utf8'));
  });
  child.stderr.on('data', chunk => {
    runtime.stderr += chunk.toString('utf8');
    process.stderr.write('[child:err] ' + chunk.toString('utf8'));
  });
  children.add(runtime);
  return runtime;
}

async function waitReady(runtime, port, pathname) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`runtime exited before ready\nstdout=${runtime.stdout}\nstderr=${runtime.stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (response.status === 200) {
        return;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error(`runtime not ready\nstdout=${runtime.stdout}\nstderr=${runtime.stderr}`);
}

async function waitForHealth(port, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const probe = await getJson(port, '/api/health').catch(() => ({body: null}));
    last = probe.body?.mutationQueue || null;
    if (last && predicate(last)) return last;
    await sleep(100);
  }
  throw new Error(`health condition not met within ${timeoutMs}ms: ${JSON.stringify(last)}`);
}

async function stopRuntime(runtime) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) return runtime.child.exitCode;
  runtime.child.kill('SIGTERM');
  return waitForExit(runtime, 15_000);
}

async function waitForExit(runtime, timeoutMs) {
  if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
    return runtime.child.exitCode ?? -1;
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(-999), timeoutMs);
    runtime.child.once('exit', code => { clearTimeout(timer); resolve(code ?? -1); });
  });
}

async function postJson(port, pathname, body) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = {raw: text}; }
    return {status: response.status, body: parsed};
  } catch (error) {
    return {status: 0, body: null, error: String(error)};
  }
}

async function getJson(port, pathname) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {signal: AbortSignal.timeout(5_000)});
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = {raw: text}; }
    return {status: response.status, body: parsed};
  } catch (error) {
    return {status: 0, body: null, error: String(error)};
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
