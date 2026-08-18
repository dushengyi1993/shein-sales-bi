#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const CHECKER = fileURLToPath(new URL('./check_partner_cli_version_change.mjs', import.meta.url));
const CI_WORKFLOW = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-version-change-'));
let testCount = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {...process.env, ...options.env},
    input: options.input,
  });
  if (result.error) throw result.error;
  return result;
}

function git(repoRoot, args) {
  const result = run('git', args, {cwd: repoRoot});
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return String(result.stdout).trim();
}

function defaultManifest(version) {
  return {
    schemaVersion: 2,
    version,
    entrypoint: 'pkg/cli.mjs',
    bootstrap: 'pkg/cli.mjs',
    codexSkill: 'pkg/cli.mjs',
    files: ['pkg/cli.mjs'],
  };
}

async function writeManifest(repoRoot, manifest) {
  await fs.mkdir(path.join(repoRoot, 'config'), {recursive: true});
  await fs.writeFile(
    path.join(repoRoot, 'config', 'partner_cli_package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

async function commitAll(repoRoot, message) {
  git(repoRoot, ['add', '--all']);
  git(repoRoot, ['commit', '--quiet', '-m', message]);
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

async function createFixture(name, {baseVersion = '2026.08.16.5', baseInstaller = true} = {}) {
  const repoRoot = path.join(tempRoot, name);
  await fs.mkdir(path.join(repoRoot, 'pkg'), {recursive: true});
  await fs.mkdir(path.join(repoRoot, 'scripts'), {recursive: true});
  git(repoRoot, ['init', '--quiet']);
  git(repoRoot, ['config', 'user.name', 'Version Boundary Test']);
  git(repoRoot, ['config', 'user.email', 'version-boundary@example.invalid']);
  git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await writeManifest(repoRoot, defaultManifest(baseVersion));
  await fs.writeFile(path.join(repoRoot, 'pkg', 'cli.mjs'), "export const value = 'base';\n", 'utf8');
  if (baseInstaller) {
    await fs.writeFile(path.join(repoRoot, 'scripts', 'install_partner_bi_ops_cli.ps1'), "Write-Output 'base'\n", 'utf8');
  }
  const base = await commitAll(repoRoot, 'base');
  return {repoRoot, base};
}

function invokeChecker(repoRoot, bases, {omitBase = false} = {}) {
  const args = [CHECKER, '--repo-root', repoRoot];
  if (!omitBase) {
    for (const base of Array.isArray(bases) ? bases : [bases]) args.push('--base', base);
  }
  return run(process.execPath, args);
}

function assertPass(result, expected = {}) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const body = JSON.parse(result.stdout);
  assert.equal(body.ok, true);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(body[key], value);
  testCount += 1;
}

function assertFail(result, fragment) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Partner CLI version boundary check failed:/);
  assert.ok(result.stderr.includes(fragment), `Expected ${JSON.stringify(fragment)} in ${JSON.stringify(result.stderr)}`);
  testCount += 1;
}

function extractMarkedSource(source, beginMarker, endMarker) {
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker, begin + beginMarker.length);
  assert.notEqual(begin, -1, `Missing marker ${beginMarker}`);
  assert.notEqual(end, -1, `Missing marker ${endMarker}`);
  return source.slice(begin + beginMarker.length, end);
}

function extractWorkflowRunBlock(source, stepName) {
  const normalized = source.replace(/\r\n/g, '\n');
  const stepStart = normalized.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(stepStart, -1, `Missing workflow step ${stepName}`);
  const runMarker = '        run: |\n';
  const runStart = normalized.indexOf(runMarker, stepStart);
  assert.notEqual(runStart, -1, `Missing run block for ${stepName}`);
  const lines = normalized.slice(runStart + runMarker.length).split('\n');
  const body = [];
  for (const line of lines) {
    if (line === '') {
      body.push('');
    } else if (line.startsWith('          ')) {
      body.push(line.slice(10));
    } else {
      break;
    }
  }
  return `${body.join('\n')}\n`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

try {
  {
    const workflowSource = await fs.readFile(CI_WORKFLOW, 'utf8');
    const validatorSource = extractMarkedSource(
      workflowSource,
      '// TRUSTED_CI_EVIDENCE_VALIDATOR_BEGIN',
      '// TRUSTED_CI_EVIDENCE_VALIDATOR_END',
    );
    const validateTrustedCiEvidence = new Function(
      `'use strict';${validatorSource};return validateTrustedCiEvidence;`,
    )();
    const trustedSha = 'a'.repeat(40);
    const currentSha = 'b'.repeat(40);
    const candidate = {
      id: 31975837912,
      run_attempt: 1,
      head_sha: trustedSha,
      head_branch: 'main',
      path: '.github/workflows/ci.yml',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.example.invalid/actions/runs/31975837912',
    };
    const job = (id, completedAt) => ({
      id,
      run_id: candidate.id,
      run_attempt: candidate.run_attempt,
      head_sha: trustedSha,
      status: 'completed',
      conclusion: 'success',
      completed_at: completedAt,
    });
    const validEvidence = {
      candidate,
      exactAttempt: clone(candidate),
      latestRun: clone(candidate),
      jobPages: [
        {total_count: 2, jobs: [job(1001, '2026-08-16T22:40:00Z')]},
        {total_count: 2, jobs: [job(1002, '2026-08-16T22:42:45Z')]},
      ],
      currentRunId: candidate.id + 100,
      currentSha,
    };
    assert.equal(Object.hasOwn(candidate, 'completed_at'), false);
    assert.equal(Object.hasOwn(validEvidence.exactAttempt, 'completed_at'), false);
    assert.equal(
      validateTrustedCiEvidence(validEvidence).completedAt,
      '2026-08-16T22:42:45Z',
      'Completion time must come from the latest exact-attempt job, not the run object',
    );
    testCount += 1;

    const assertEvidenceRejected = (mutate, pattern) => {
      const evidence = clone(validEvidence);
      mutate(evidence);
      assert.throws(() => validateTrustedCiEvidence(evidence), pattern);
      testCount += 1;
    };
    assertEvidenceRejected(evidence => {
      evidence.jobPages = [{total_count: 0, jobs: []}];
    }, /total_count must be positive/);
    assertEvidenceRejected(evidence => {
      evidence.candidate = null;
    }, /candidate identity is incomplete/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].conclusion = 'failure';
    }, /not completed\+success/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].conclusion = 'neutral';
    }, /not completed\+success/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].conclusion = 'skipped';
    }, /not completed\+success/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].status = 'in_progress';
    }, /not completed\+success/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].run_attempt = 2;
    }, /identity or attempt/);
    assertEvidenceRejected(evidence => {
      evidence.exactAttempt.run_attempt = 2;
    }, /Exact attempt is not the exact/);
    assertEvidenceRejected(evidence => {
      evidence.latestRun.path = '.github/workflows/other.yml';
    }, /Latest run is not the exact/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].completed_at = null;
    }, /completed_at is missing or invalid/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[1].jobs[0].completed_at = 'not-an-api-timestamp';
    }, /completed_at is missing or invalid/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages[0].total_count = 3;
      evidence.jobPages[1].total_count = 3;
    }, /pagination is incomplete/);
    assertEvidenceRejected(evidence => {
      evidence.jobPages.push({total_count: 2, jobs: []});
    }, /page 3 is malformed or inconsistent/);
    assertEvidenceRejected(evidence => {
      evidence.currentRunId = evidence.candidate.id;
      evidence.currentSha = evidence.candidate.head_sha;
    }, /must precede and differ/);

    const jobsEndpoint = '/actions/runs/$trusted_run_id/attempts/$trusted_run_attempt/jobs?per_page=100';
    const jobsEndpointIndex = workflowSource.indexOf(jobsEndpoint);
    assert.notEqual(jobsEndpointIndex, -1, 'Exact-attempt jobs endpoint is missing');
    const jobsCommandStart = workflowSource.lastIndexOf('gh api ', jobsEndpointIndex);
    const jobsCommand = workflowSource.slice(jobsCommandStart, jobsEndpointIndex + jobsEndpoint.length);
    assert.match(jobsCommand, /^gh api --paginate --slurp --method GET/);
    assert.doesNotMatch(
      workflowSource,
      /trusted_completed_at="\$\(jq -r '\.completed_at/,
      'Workflow run objects do not expose completed_at',
    );
    testCount += 1;

    const bashSyntax = run('bash', ['-n'], {
      input: extractWorkflowRunBlock(workflowSource, 'Check Partner CLI version boundary'),
    });
    assert.equal(bashSyntax.status, 0, bashSyntax.stderr || bashSyntax.stdout);
    testCount += 1;

    const stateMachineSource = extractMarkedSource(
      workflowSource,
      '// PARTNER_CLI_BASELINE_STATE_MACHINE_BEGIN',
      '// PARTNER_CLI_BASELINE_STATE_MACHINE_END',
    );
    const decidePartnerCliBaselineState = new Function(
      `'use strict';${stateMachineSource};return decidePartnerCliBaselineState;`,
    )();
    const beforeSha = 'c'.repeat(40);
    const trustedState = {
      sha: trustedSha,
      runId: candidate.id,
      runAttempt: candidate.run_attempt,
      url: candidate.html_url,
      completedAt: '2026-08-16T22:42:45Z',
      status: 'completed',
      conclusion: 'success',
      fetched: true,
    };
    const stateFor = before => ({currentSha, before, trusted: clone(trustedState)});
    assert.deepEqual(
      decidePartnerCliBaselineState(stateFor({
        sha: beforeSha,
        allZero: false,
        resolvable: true,
        resolvedCommit: beforeSha,
      })).bases,
      [beforeSha, trustedSha],
    );
    testCount += 1;
    assert.deepEqual(
      decidePartnerCliBaselineState(stateFor({
        sha: '0'.repeat(40),
        allZero: true,
        resolvable: false,
        resolvedCommit: '',
      })),
      {
        bases: [trustedSha],
        beforeMode: 'all-zero-trusted-fallback',
        trustedRunId: candidate.id,
        trustedRunAttempt: candidate.run_attempt,
        trustedUrl: candidate.html_url,
      },
    );
    testCount += 1;
    assert.equal(
      decidePartnerCliBaselineState(stateFor({
        sha: beforeSha,
        allZero: false,
        resolvable: false,
        resolvedCommit: '',
      })).beforeMode,
      'unreachable-trusted-fallback',
    );
    testCount += 1;
    assert.throws(
      () => decidePartnerCliBaselineState({
        ...stateFor({sha: beforeSha, allZero: false, resolvable: true, resolvedCommit: beforeSha}),
        trusted: null,
      }),
      /baseline is required/,
    );
    testCount += 1;
    assert.throws(
      () => decidePartnerCliBaselineState({
        ...stateFor({sha: beforeSha, allZero: false, resolvable: true, resolvedCommit: beforeSha}),
        trusted: {...trustedState, sha: currentSha},
      }),
      /points at current SHA/,
    );
    testCount += 1;
  }

  {
    const checkerSource = await fs.readFile(CHECKER, 'utf8');
    assert.doesNotMatch(checkerSource, /node:(?:http|https|net|tls|dns)|\bfetch\s*\(|\bcurl\b|\bgh\b/);
    testCount += 1;
  }

  {
    const {repoRoot, base} = await createFixture('unchanged');
    assertPass(invokeChecker(repoRoot, base), {versionChange: 'unchanged', boundaryChanges: []});
  }

  {
    const {repoRoot, base} = await createFixture('duplicate-bases');
    assertPass(invokeChecker(repoRoot, [base, base]), {baseCount: 1});
  }

  {
    const {repoRoot, base} = await createFixture('package-drift');
    await fs.writeFile(path.join(repoRoot, 'pkg', 'cli.mjs'), "export const value = 'changed';\n", 'utf8');
    await commitAll(repoRoot, 'change package file');
    assertFail(invokeChecker(repoRoot, base), 'package-file:pkg/cli.mjs:modified');
  }

  {
    const {repoRoot, base} = await createFixture('manifest-drift');
    const manifest = defaultManifest('2026.08.16.5');
    manifest.schemaVersion = 3;
    await writeManifest(repoRoot, manifest);
    await commitAll(repoRoot, 'change manifest field');
    assertFail(invokeChecker(repoRoot, base), 'manifest:config/partner_cli_package.json:modified');
  }

  {
    const {repoRoot, base} = await createFixture('installer-drift');
    await fs.writeFile(path.join(repoRoot, 'scripts', 'install_partner_bi_ops_cli.ps1'), "Write-Output 'changed'\n", 'utf8');
    await commitAll(repoRoot, 'change installer');
    assertFail(invokeChecker(repoRoot, base), 'installer:scripts/install_partner_bi_ops_cli.ps1:modified');
  }

  {
    const {repoRoot, base} = await createFixture('valid-increase');
    await writeManifest(repoRoot, defaultManifest('2026.08.17.1'));
    await fs.writeFile(path.join(repoRoot, 'pkg', 'cli.mjs'), "export const value = 'changed with version';\n", 'utf8');
    await commitAll(repoRoot, 'increase version with content');
    const result = invokeChecker(repoRoot, base);
    assertPass(result, {versionChange: 'increased', currentVersion: '2026.08.17.1'});
    const body = JSON.parse(result.stdout);
    assert.ok(body.boundaryChanges.some(item => item.kind === 'manifest'));
    assert.ok(body.boundaryChanges.some(item => item.kind === 'package-file'));
  }

  {
    const {repoRoot, base} = await createFixture('installer-added-with-version', {baseInstaller: false});
    await writeManifest(repoRoot, defaultManifest('2026.08.17.1'));
    await fs.writeFile(path.join(repoRoot, 'scripts', 'install_partner_bi_ops_cli.ps1'), "Write-Output 'added'\n", 'utf8');
    await commitAll(repoRoot, 'add installer with increased version');
    const result = invokeChecker(repoRoot, base);
    assertPass(result, {versionChange: 'increased'});
    assert.ok(JSON.parse(result.stdout).boundaryChanges.some(item => (
      item.kind === 'installer' && item.change === 'added'
    )));
  }

  {
    const {repoRoot, base} = await createFixture('rollback', {baseVersion: '2026.08.17.2'});
    await writeManifest(repoRoot, defaultManifest('2026.08.17.1'));
    await commitAll(repoRoot, 'roll back version');
    assertFail(invokeChecker(repoRoot, base), 'Partner CLI version rollback is forbidden');
  }

  {
    const {repoRoot, base: beforeA} = await createFixture('failed-baseline-whitening', {baseVersion: '2026.08.16.4'});
    await writeManifest(repoRoot, defaultManifest('2026.08.16.5'));
    const commitA = await commitAll(repoRoot, 'A successful version increase');
    assertPass(invokeChecker(repoRoot, beforeA), {currentVersion: '2026.08.16.5'});

    await fs.writeFile(path.join(repoRoot, 'pkg', 'cli.mjs'), "export const value = 'B drift';\n", 'utf8');
    const commitB = await commitAll(repoRoot, 'B same-version package drift');
    assertFail(invokeChecker(repoRoot, commitA), 'package-file:pkg/cli.mjs:modified');

    await fs.writeFile(path.join(repoRoot, 'README.md'), 'C documentation only\n', 'utf8');
    await commitAll(repoRoot, 'C documentation-only whitening attempt');
    const result = invokeChecker(repoRoot, [commitB, commitA]);
    assertFail(result, `relative to ${commitA}`);
  }

  {
    const {repoRoot, base} = await createFixture('multi-commit-push');
    await fs.writeFile(path.join(repoRoot, 'pkg', 'cli.mjs'), "export const value = 'earlier drift';\n", 'utf8');
    await commitAll(repoRoot, 'earlier package commit');
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'later documentation commit\n', 'utf8');
    await commitAll(repoRoot, 'later documentation commit');
    assertFail(invokeChecker(repoRoot, base), 'package-file:pkg/cli.mjs:modified');
  }

  {
    const {repoRoot, base} = await createFixture('invalid-current');
    await writeManifest(repoRoot, defaultManifest('2026.02.30.1'));
    await commitAll(repoRoot, 'invalid current version');
    assertFail(invokeChecker(repoRoot, base), 'Current version is invalid: 2026.02.30.1');
  }

  {
    const {repoRoot, base} = await createFixture('invalid-base', {baseVersion: '2026.13.01.1'});
    await writeManifest(repoRoot, defaultManifest('2026.08.17.1'));
    await commitAll(repoRoot, 'valid current version');
    assertFail(invokeChecker(repoRoot, base), 'Base version is invalid: 2026.13.01.1');
  }

  {
    const {repoRoot} = await createFixture('empty-base');
    assertFail(invokeChecker(repoRoot, ''), '--base values must not be empty');
  }

  {
    const {repoRoot} = await createFixture('missing-base');
    assertFail(invokeChecker(repoRoot, 'definitely-not-a-ref'), 'Base ref/commit #1 cannot be resolved to a commit');
  }

  {
    const {repoRoot} = await createFixture('omitted-base');
    assertFail(invokeChecker(repoRoot, '', {omitBase: true}), 'At least one --base is required');
  }
} finally {
  await fs.rm(tempRoot, {recursive: true, force: true});
}

await assert.rejects(fs.access(tempRoot));
process.stdout.write(`${JSON.stringify({ok: true, tests: testCount, tempCleaned: true})}\n`);
