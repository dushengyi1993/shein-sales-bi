import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The cloud coordinator defers marketing writes with `deferred_to_local`, but
// after the fnOS migration nothing local consumed that deferral: the two local
// Codex automations are read-only 11:30 summaries. The local entry must exist,
// must reuse the cloud slot's gating instead of forking it, and must fail
// closed when there is no same-day queue or no explicit authorization.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'scripts', 'run_local_marketing_repair_slot.sh');
const SLOT = path.join(ROOT, 'scripts', 'run_cloud_marketing_fallback_slot.sh');
const WORKER = path.join(ROOT, 'scripts', 'cloud_marketing_repair_worker.sh');
// tmp/ is gitignored, so a fresh checkout does not have it and shard membership
// decides whether a creator test happens to run first. Create it explicitly,
// like the other repo-scratch tests do.
await fsp.mkdir(path.join(ROOT, 'tmp'), {recursive: true});
const tempRoot = await fsp.mkdtemp(path.join(ROOT, 'tmp', 'local-marketing-entry-'));
let checks = 0;
const ok = label => { checks += 1; console.log(`PASS ${label}`); };

const bashAvailable = () => {
  const probe = spawnSync('bash', ['--version'], {encoding: 'utf8'});
  return probe.status === 0;
};
// The bash on PATH is a WSL/Git shell that cannot resolve `C:/...` paths, so the
// entry is invoked with repo-relative POSIX paths and an explicit cwd, the same
// way the other shell-contract tests do it.
const relativeToRoot = value => path.relative(ROOT, value).split(path.sep).join('/');

try {
  const source = await fsp.readFile(ENTRY, 'utf8');
  // Prose may explain what the entry does not do; only executable lines matter.
  const code = source.split('\n').filter(line => !/^\s*#/u.test(line)).join('\n');

  // 1. The local entry reuses the cloud slot and its bounded worker rather than
  //    re-implementing authorization, deadlines or the host-heavy lane.
  assert.match(source, /exec \/usr\/bin\/env bash "\$ROOT\/scripts\/run_cloud_marketing_fallback_slot\.sh"/,
    'the local entry must exec the shared cloud slot');
  assert.ok(fs.existsSync(SLOT) && fs.existsSync(WORKER), 'the reused slot and worker must exist');
  assert.doesNotMatch(code, /--max-groups|batch_|scan_|signup|repric/i,
    'the entry must not re-implement bounded execution, scanning or repricing');
  ok('the local entry reuses the shared slot and worker');

  // 2. Explicit opt-in, and the authorization/dequeue ordering are all present.
  const locationCheck = source.indexOf('SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION');
  const queueCheck = source.indexOf('no same-day repair queue');
  const authorizationCheck = source.indexOf('no immediate authorization');
  assert.ok(locationCheck > 0 && queueCheck > locationCheck && authorizationCheck > queueCheck,
    'the entry must check opt-in, then the queue, then the authorization, in that order');
  assert.match(source, /export SHEIN_BI_MARKETING_IMMEDIATE_RUN=true/,
    'a local run is always the explicitly authorized immediate path');
  assert.match(source, /export SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED=false/,
    'a local run must not claim the cloud primary budget mode');
  ok('opt-in, queue and authorization gates are declared in fail-closed order');

  if (!bashAvailable()) {
    console.log('NOTE bash runtime unavailable; static contract only');
    console.log(JSON.stringify({ok: true, checks, bashBehavior: 'skipped'}, null, 2));
    process.exit(0);
  }

  const stateDir = path.join(tempRoot, 'state', 'cloud_marketing_live_guard');
  const authorizationFile = path.join(tempRoot, 'marketing-repair-immediate', 'authorization.json');
  // The shell on PATH is a WSL/Git bash that does not inherit the Windows
  // environment, so the scenario variables are assigned inside the shell.
  const runEntry = extraEnv => {
    const assignments = Object.entries({
      SHEIN_BI_ROOT: '.',
      SHEIN_BI_TZ: 'Asia/Shanghai',
      SHEIN_BI_MARKETING_LIVE_STATE_DIR: relativeToRoot(stateDir),
      SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE: relativeToRoot(authorizationFile),
      ...extraEnv,
    }).map(([key, value]) => `${key}='${String(value).replace(/'/gu, "'\\''")}'`).join(' ');
    return spawnSync('bash', ['-c', `${assignments} bash scripts/run_local_marketing_repair_slot.sh`], {encoding: 'utf8', cwd: ROOT});
  };

  // 3. Without the explicit opt-in the entry refuses to act.
  const noOptIn = runEntry({});
  assert.equal(noOptIn.status, 64, `missing opt-in must exit 64, got ${noOptIn.status}: ${noOptIn.stderr}`);
  assert.match(noOptIn.stderr, /EXECUTION_LOCATION=local/u);
  ok('a run without the local opt-in is refused');

  // 4. An idle day writes nothing.
  const noQueue = runEntry({SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'local'});
  assert.equal(noQueue.status, 75, `no queue must defer with 75, got ${noQueue.status}: ${noQueue.stderr}`);
  assert.match(noQueue.stderr, /no same-day repair queue/u);
  ok('no same-day queue defers instead of inventing work');

  // 5. A queue without an explicit authorization is not authorization to write.
  await fsp.mkdir(path.join(stateDir, 'repair-queues'), {recursive: true});
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  await fsp.writeFile(path.join(stateDir, 'repair-queues', `marketing-repair-${today}.json`), '{"stages":{}}\n', 'utf8');
  const noAuthorization = runEntry({SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION: 'local'});
  assert.equal(noAuthorization.status, 75, `no authorization must defer with 75, got ${noAuthorization.status}: ${noAuthorization.stderr}`);
  assert.match(noAuthorization.stderr, /no immediate authorization/u);
  ok('a queue without authorization defers instead of writing');

  console.log(JSON.stringify({ok: true, checks}, null, 2));
} finally {
  await fsp.rm(tempRoot, {recursive: true, force: true});
}
