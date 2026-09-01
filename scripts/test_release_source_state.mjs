#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  DEPLOYMENT_MARKER_MAX_BYTES,
  inspectDeploymentReleaseEvidence,
  inspectRecordedDeploymentReleaseEvidence,
  inspectReleaseSourceState,
  recordDeploymentRelease,
} from './check_release_source_state.mjs';
import {
  buildDeployedReleaseMarker,
  DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
  expectedAnnotatedTagMessage,
  readRegularBoundedFile,
  readRegularBoundedFileAsync,
  sha256Hex,
  validateDeployedReleaseMarker,
  verifySourceReleaseAttestationFiles,
} from '../lib/source_release_attestation.mjs';
import {
  buildPublicationJournal,
  createGitHubEvidenceClient,
  decideSourceReleaseState,
  deriveCiAttemptEvidence,
  fetchCiBindingEvidence,
  SOURCE_RELEASE_PUBLISH_STATES,
  validateSourceReleaseTrustPolicy,
  verifyRemoteSourceReleaseEvidence,
} from '../lib/source_release_github_evidence.mjs';

const REQUIRED_CI_JOB_NAMES = Object.freeze([
  'Source checks',
  'Deterministic shard 1/4',
  'Deterministic shard 2/4',
  'Deterministic shard 3/4',
  'Deterministic shard 4/4',
  'Release gate',
  'CI terminal gate',
]);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function expectCode(promiseOrCallback, code) {
  const promise = typeof promiseOrCallback === 'function'
    ? Promise.resolve().then(promiseOrCallback)
    : promiseOrCallback;
  return assert.rejects(promise, error => error?.code === code, `expected error code ${code}`);
}

function response(body, status = 200, contentType = 'application/json') {
  const value = contentType === 'application/json' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  return new Response(value, {status, headers: {'content-type': contentType}});
}

function fixtureFetch(routes) {
  return async url => {
    const key = new URL(url).pathname + new URL(url).search;
    const route = routes.get(key);
    if (!route) throw new Error(`unexpected fixture URL: ${key}`);
    if (typeof route === 'function') return route(key);
    return route.clone();
  };
}

function sourcePolicy() {
  return validateSourceReleaseTrustPolicy({
    schemaVersion: 'shein-bi-source-release-trust-policy/v1',
    repository: {id: 1228612468, fullName: 'dushengyi1993/shein-sales-bi', defaultBranch: 'main'},
    ci: {
      workflowPath: '.github/workflows/ci.yml',
      workflowApiId: 'ci.yml',
      event: 'push',
      branch: 'main',
      requiredRunConclusion: 'success',
      requiredJobNames: [...REQUIRED_CI_JOB_NAMES],
      allowedJobConclusions: ['success'],
    },
    sourceRelease: {
      workflowPath: '.github/workflows/source-release.yml',
      releaseTitlePrefix: 'SHEIN BI Ops ',
      assetNames: ['release-attestation.json', 'release-attestation.json.sha256'],
      requireImmutableReleases: true,
      requireOwnerEnforcement: false,
    },
  });
}

function ciRun({commit, runId = 500, attempt = 1} = {}) {
  return {
    id: runId,
    run_attempt: attempt,
    head_sha: commit,
    head_branch: 'main',
    event: 'push',
    path: '.github/workflows/ci.yml',
    html_url: `https://github.com/dushengyi1993/shein-sales-bi/actions/runs/${runId}`,
    status: 'completed',
    conclusion: 'success',
    completed_at: null,
  };
}

function ciJobs({runId = 500, attempt = 1} = {}) {
  const completedAt = [
    '2026-08-17T01:02:03Z',
    '2026-08-17T01:02:23Z',
    '2026-08-17T01:02:43Z',
    '2026-08-17T01:03:03Z',
    '2026-08-17T01:03:23Z',
    '2026-08-17T01:03:43Z',
    '2026-08-17T01:04:05Z',
  ];
  return REQUIRED_CI_JOB_NAMES.map((name, index) => ({
    id: runId * 10 + index + 1,
    name,
    run_id: runId,
    run_attempt: attempt,
    status: 'completed',
    conclusion: 'success',
    completed_at: completedAt[index],
  }));
}

function routeKey(value) {
  const url = new URL(value, 'https://api.github.test');
  return `${url.pathname}${url.search}`;
}

function buildRemoteRoutes(fixture, overrides = {}) {
  const {
    policy, commit, version, ci, tagObject, tagMessage, release, attestationBytes, checksumBytes,
  } = fixture;
  const repo = policy.repository.fullName;
  const routes = new Map();
  routes.set(routeKey(`/repos/${repo}`), response(overrides.repository || {
    id: policy.repository.id,
    full_name: repo,
    default_branch: 'main',
  }));
  routes.set(routeKey(`/repos/${repo}/immutable-releases`), response(overrides.immutable || {
    enabled: true,
    enforced_by_owner: false,
  }));
  const boundRun = overrides.boundRun || ciRun({commit, runId: ci.runId, attempt: ci.runAttempt});
  const boundJobs = overrides.boundJobs || ciJobs({runId: ci.runId, attempt: ci.runAttempt});
  routes.set(routeKey(`/repos/${repo}/actions/runs/${ci.runId}/attempts/${ci.runAttempt}`), response(boundRun));
  routes.set(
    routeKey(`/repos/${repo}/actions/runs/${ci.runId}/attempts/${ci.runAttempt}/jobs?filter=all&per_page=100&page=1`),
    response({total_count: boundJobs.length, jobs: boundJobs}),
  );
  const latestRun = overrides.latestRun || boundRun;
  const latestJobs = overrides.latestJobs || boundJobs;
  routes.set(
    routeKey(`/repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${commit}&per_page=100&page=1`),
    response({total_count: 1, workflow_runs: [latestRun]}),
  );
  routes.set(routeKey(`/repos/${repo}/actions/runs/${latestRun.id}`), response(overrides.mutableLatestRun || latestRun));
  routes.set(routeKey(`/repos/${repo}/actions/runs/${latestRun.id}/attempts/${latestRun.run_attempt}`), response(latestRun));
  routes.set(
    routeKey(`/repos/${repo}/actions/runs/${latestRun.id}/attempts/${latestRun.run_attempt}/jobs?filter=all&per_page=100&page=1`),
    response({total_count: latestJobs.length, jobs: latestJobs}),
  );
  routes.set(routeKey(`/repos/${repo}/git/ref/tags/${version}`), response(overrides.tagRef || {
    ref: `refs/tags/${version}`,
    object: {type: 'tag', sha: tagObject},
  }));
  routes.set(routeKey(`/repos/${repo}/git/tags/${tagObject}`), response(overrides.tagApiObject || {
    sha: tagObject,
    message: tagMessage,
    object: {type: 'commit', sha: commit},
  }));
  routes.set(routeKey(`/repos/${repo}/releases?per_page=100&page=1`), response([overrides.release || release]));
  const remoteAssetBytes = overrides.remoteAssetBytes || {
    'release-attestation.json': attestationBytes,
    'release-attestation.json.sha256': checksumBytes,
  };
  for (const asset of (overrides.release || release).assets) {
    routes.set(
      routeKey(`/repos/${repo}/releases/assets/${asset.id}`),
      response(remoteAssetBytes[asset.name] || Buffer.from('drift\n'), 200, 'application/octet-stream'),
    );
  }
  return routes;
}

function clientFor(routes) {
  return createGitHubEvidenceClient({fetchImpl: fixtureFetch(routes), apiBaseUrl: 'https://api.github.test'});
}

function releaseStateFixture(fixture, releaseOverrides = {}) {
  return {
    version: fixture.version,
    expectedCommit: fixture.commit,
    observedMain: fixture.commit,
    expectedTitle: `SHEIN BI Ops ${fixture.version}`,
    attestationSha256: fixture.attestationSha256,
    expectedAssets: fixture.expectedAssets,
    tag: {exists: true, type: 'tag', peeledCommit: fixture.commit, messageMatches: true},
    release: {
      exists: true,
      id: 700,
      tagName: fixture.version,
      title: `SHEIN BI Ops ${fixture.version}`,
      body: fixture.publishedBody,
      draft: false,
      prerelease: false,
      immutable: true,
      publishedAt: '2026-08-17T02:00:00Z',
      assets: fixture.release.assets,
      ...releaseOverrides,
    },
  };
}

let testCount = 0;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shein-release-state-v3-'));
try {
  const policy = sourcePolicy();
  const policyBytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  const policySha256 = sha256Hex(policyBytes);
  await fs.mkdir(path.join(tmp, 'config'), {recursive: true});
  await fs.writeFile(path.join(tmp, 'config', 'source_release_trust_policy.json'), policyBytes);
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'v1\n');
  git(tmp, ['init', '-q']);
  git(tmp, ['config', 'user.name', 'Release State Test']);
  git(tmp, ['config', 'user.email', 'release-state@example.invalid']);
  git(tmp, ['remote', 'add', 'origin', 'https://github.com/dushengyi1993/shein-sales-bi.git']);
  git(tmp, ['add', 'tracked.txt', 'config/source_release_trust_policy.json']);
  git(tmp, ['commit', '-q', '-m', 'fixture']);
  const commit = git(tmp, ['rev-parse', 'HEAD']);
  const version = '2026.08.17.7';
  const run = ciRun({commit});
  const jobs = ciJobs();
  const derived = deriveCiAttemptEvidence({
    run,
    jobs,
    policy,
    expectedCommit: commit,
    expectedRunId: run.id,
    expectedRunAttempt: run.run_attempt,
  });
  assert.equal(run.completed_at, null, 'fixture must model real GitHub run without completed_at');
  assert.deepEqual(policy.ci.requiredJobNames, REQUIRED_CI_JOB_NAMES);
  assert.equal(derived.completedAt, '2026-08-17T01:04:05Z');
  assert.equal(derived.jobCount, 7);
  testCount += 1;

  const ci = {
    workflow: derived.workflow,
    event: derived.event,
    branch: derived.branch,
    runId: derived.runId,
    runAttempt: derived.runAttempt,
    url: derived.url,
    completedAt: derived.completedAt,
    jobCount: derived.jobCount,
    jobsSha256: derived.jobsSha256,
  };
  const attestation = {
    schemaVersion: 3,
    repository: {id: policy.repository.id, fullName: policy.repository.fullName},
    version,
    tag: version,
    commit,
    trustPolicySha256: policySha256,
    ci,
    sourceWorkflow: {path: policy.sourceRelease.workflowPath},
  };
  const attestationBytes = Buffer.from(`${JSON.stringify(attestation, null, 2)}\n`);
  const attestationSha256 = sha256Hex(attestationBytes);
  const checksumBytes = Buffer.from(`${attestationSha256}  release-attestation.json\n`);
  const expectedAssets = {
    'release-attestation.json': {size: attestationBytes.length, digest: `sha256:${attestationSha256}`},
    'release-attestation.json.sha256': {size: checksumBytes.length, digest: `sha256:${sha256Hex(checksumBytes)}`},
  };
  const attestationRoot = path.join(tmp, '.git', 'release-attestations');
  const releaseDir = path.join(attestationRoot, version);
  await fs.mkdir(releaseDir, {recursive: true});
  const attestationFile = path.join(releaseDir, 'release-attestation.json');
  const checksumFile = path.join(releaseDir, 'release-attestation.json.sha256');
  await fs.writeFile(attestationFile, attestationBytes);
  await fs.writeFile(checksumFile, checksumBytes);
  const tagMessage = expectedAnnotatedTagMessage({tag: version, commit, ci, attestationSha256});
  const tagMessageFile = path.join(releaseDir, 'tag-message.txt');
  await fs.writeFile(tagMessageFile, tagMessage);
  git(tmp, ['tag', '--annotate', '--cleanup=verbatim', '--file', tagMessageFile, version, commit]);
  const tagObject = git(tmp, ['rev-parse', `refs/tags/${version}`]);
  const publishedBody = [
    `Source release ${version}`,
    '',
    buildPublicationJournal({
      state: SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
      tag: version,
      commit,
      attestationSha256,
    }),
    '',
  ].join('\n');
  const release = {
    id: 700,
    tag_name: version,
    name: `SHEIN BI Ops ${version}`,
    body: publishedBody,
    draft: false,
    prerelease: false,
    immutable: true,
    published_at: '2026-08-17T02:00:00Z',
    html_url: `https://github.com/dushengyi1993/shein-sales-bi/releases/tag/${version}`,
    assets: [
      {id: 701, name: 'release-attestation.json', state: 'uploaded', ...expectedAssets['release-attestation.json']},
      {id: 702, name: 'release-attestation.json.sha256', state: 'uploaded', ...expectedAssets['release-attestation.json.sha256']},
    ],
  };
  const fixture = {
    policy,
    policySha256,
    commit,
    version,
    ci,
    tagObject,
    tagMessage,
    release,
    publishedBody,
    attestationBytes,
    checksumBytes,
    attestationSha256,
    expectedAssets,
  };

  const clean = inspectReleaseSourceState({cwd: tmp, expectedCommit: commit});
  assert.equal(clean.ok, true);
  assert.match(clean.sourceFingerprint, /^[0-9a-f]{64}$/);
  testCount += 1;

  for (const [name, mutatedJobs, code] of [
    ['missing required job', jobs.slice(0, -1), 'SOURCE_RELEASE_CI_REQUIRED_JOB_MISSING'],
    ['duplicate required job', [...jobs, {...jobs[0], id: 5099}], 'SOURCE_RELEASE_CI_REQUIRED_JOB_DUPLICATE'],
    ['incomplete', jobs.map((job, index) => index === 0
      ? {...job, status: 'in_progress', conclusion: null, completed_at: null}
      : job), 'SOURCE_RELEASE_CI_JOBS_INCOMPLETE'],
    ['failure', jobs.map((job, index) => index === 0 ? {...job, conclusion: 'failure'} : job), 'SOURCE_RELEASE_CI_JOB_FAILED'],
    ['attempt mismatch', jobs.map((job, index) => index === 0 ? {...job, run_attempt: 2} : job), 'SOURCE_RELEASE_CI_JOB_ATTEMPT_MISMATCH'],
  ]) {
    assert.throws(
      () => deriveCiAttemptEvidence({run, jobs: mutatedJobs, policy, expectedCommit: commit, expectedRunId: 500, expectedRunAttempt: 1}),
      error => error?.code === code,
      name,
    );
    testCount += 1;
  }

  const incompletePages = buildRemoteRoutes({
    policy,
    commit,
    version,
    ci,
    tagObject,
    tagMessage,
    release: {assets: []},
    attestationBytes,
    checksumBytes,
  });
  incompletePages.set(
    routeKey('/repos/dushengyi1993/shein-sales-bi/actions/runs/500/attempts/1/jobs?filter=all&per_page=100&page=1'),
    response({total_count: jobs.length + 1, jobs}),
  );
  await expectCode(() => fetchCiBindingEvidence({
    client: clientFor(incompletePages), policy, commit, boundRunId: 500, boundRunAttempt: 1, requireLatest: true,
  }), 'SOURCE_RELEASE_GITHUB_PAGINATION_INCOMPLETE');
  testCount += 1;

  const remote = await verifyRemoteSourceReleaseEvidence({
    ...fixture,
    tag: version,
    trustPolicySha256: policySha256,
    client: clientFor(buildRemoteRoutes(fixture)),
    now: () => new Date('2026-08-17T03:00:00Z'),
  });
  assert.equal(remote.releaseId, 700);
  assert.equal(remote.assets.length, 2);
  assert.deepEqual(remote.warnings, []);
  testCount += 1;

  const verifiedFiles = verifySourceReleaseAttestationFiles({
    attestationFile,
    checksumFile,
    expectedRepository: policy.repository.fullName,
    expectedRepositoryId: policy.repository.id,
    expectedTag: version,
    expectedCommit: commit,
    expectedTrustPolicySha256: policySha256,
  });
  assert.equal(Buffer.isBuffer(verifiedFiles.attestationBytes), true);
  assert.equal(Buffer.isBuffer(verifiedFiles.checksumBytes), true);
  assert.equal(
    verifiedFiles.attestationBytes.equals(attestationBytes),
    true,
    'attestation bytes must come from the single bounded verification read',
  );
  assert.equal(verifiedFiles.checksumBytes.equals(checksumBytes), true);
  const inspected = inspectDeploymentReleaseEvidence({
    cwd: tmp,
    tag: version,
    commit,
    attestationFile,
    checksumFile,
    trustPolicyFile: path.join(tmp, 'config', 'source_release_trust_policy.json'),
  });
  assert.equal(
    inspected.attestationBytes.equals(attestationBytes),
    true,
    'inspected attestation bytes must be the exact verified bytes, not a second path read',
  );
  assert.equal(inspected.checksumBytes.equals(checksumBytes), true);
  testCount += 1;

  const bounded = path.join(releaseDir, 'bounded.bin');
  await fs.writeFile(bounded, Buffer.alloc(128, 0x61));
  assert.equal(readRegularBoundedFile(bounded, 128, 'fixture').length, 128);
  assert.equal(readRegularBoundedFile(bounded, 128, 'fixture').equals(Buffer.alloc(128, 0x61)), true);
  assert.throws(
    () => readRegularBoundedFile(bounded, 127, 'fixture'),
    error => error?.code === 'SOURCE_RELEASE_FILE_SIZE_INVALID',
    'over-bound reads must fail closed',
  );
  const asyncBounded = await readRegularBoundedFileAsync(bounded, 128, 'fixture');
  assert.equal(asyncBounded.bytes.equals(Buffer.alloc(128, 0x61)), true);
  const stableLstat = await fs.lstat(bounded);
  assert.equal(asyncBounded.identity.dev, Number(stableLstat.dev));
  assert.equal(asyncBounded.identity.ino, Number(stableLstat.ino));
  assert.equal(asyncBounded.identity.size, 128);
  await fs.writeFile(bounded, Buffer.alloc(0));
  assert.throws(
    () => readRegularBoundedFile(bounded, 128, 'fixture'),
    error => error?.code === 'SOURCE_RELEASE_FILE_SIZE_INVALID',
    'empty files must fail closed',
  );
  assert.throws(
    () => readRegularBoundedFile(tmp, 1024, 'fixture'),
    error => error?.code === 'SOURCE_RELEASE_FILE_TYPE_INVALID',
    'non-regular paths must fail closed',
  );
  const linkFile = path.join(releaseDir, 'attestation-link.json');
  let symlinkCreated = false;
  try {
    await fs.symlink(attestationFile, linkFile);
    symlinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'EOPNOTSUPP'].includes(error?.code)) throw error;
  }
  if (symlinkCreated) {
    assert.throws(
      () => readRegularBoundedFile(linkFile, 64 * 1024, 'release attestation link'),
      error => error?.code === 'SOURCE_RELEASE_FILE_TYPE_INVALID',
      'symlink paths must be rejected',
    );
    await fs.rm(linkFile);
    testCount += 1;
  }
  await fs.rm(bounded);

  await expectCode(() => verifyRemoteSourceReleaseEvidence({
    ...fixture,
    tag: version,
    trustPolicySha256: policySha256,
    client: clientFor(buildRemoteRoutes(fixture, {repository: {id: 43, full_name: 'dushengyi1993/shein-sales-bi', default_branch: 'main'}})),
  }), 'SOURCE_RELEASE_REPOSITORY_DRIFT');
  testCount += 1;

  assert.throws(
    () => validateSourceReleaseTrustPolicy({...policy, ci: {...policy.ci, workflowPath: '.github/workflows/other.yml'}}),
    error => error?.code === 'SOURCE_RELEASE_POLICY_INVALID',
  );
  assert.throws(
    () => validateSourceReleaseTrustPolicy({...policy, repository: {...policy.repository, fullName: 'attacker/forged-repo'}}),
    error => error?.code === 'SOURCE_RELEASE_POLICY_INVALID',
  );
  assert.throws(
    () => validateSourceReleaseTrustPolicy({...policy, repository: {...policy.repository, id: policy.repository.id + 1}}),
    error => error?.code === 'SOURCE_RELEASE_POLICY_INVALID',
  );
  testCount += 1;

  const digestDriftRelease = {
    ...release,
    assets: release.assets.map(asset => asset.name === 'release-attestation.json'
      ? {...asset, digest: `sha256:${'0'.repeat(64)}`}
      : asset),
  };
  await expectCode(() => verifyRemoteSourceReleaseEvidence({
    ...fixture,
    tag: version,
    trustPolicySha256: policySha256,
    client: clientFor(buildRemoteRoutes(fixture, {release: digestDriftRelease})),
  }), 'SOURCE_RELEASE_REMOTE_RELEASE_CONFLICT');
  testCount += 1;

  await expectCode(() => verifyRemoteSourceReleaseEvidence({
    ...fixture,
    tag: version,
    trustPolicySha256: policySha256,
    client: clientFor(buildRemoteRoutes(fixture, {
      remoteAssetBytes: {
        'release-attestation.json': Buffer.from('locally forged attestation\n'),
        'release-attestation.json.sha256': checksumBytes,
      },
    })),
  }), 'SOURCE_RELEASE_REMOTE_ASSET_BYTES_DRIFT');
  testCount += 1;

  const rerun = ciRun({commit, runId: 500, attempt: 2});
  const rerunJobs = ciJobs({runId: 500, attempt: 2});
  const rerunRoutes = buildRemoteRoutes(fixture, {latestRun: rerun, latestJobs: rerunJobs});
  const rerunEvidence = await fetchCiBindingEvidence({
    client: clientFor(rerunRoutes),
    policy,
    commit,
    boundRunId: 500,
    boundRunAttempt: 1,
    requireLatest: false,
  });
  assert.equal(rerunEvidence.bound.runAttempt, 1);
  assert.equal(rerunEvidence.latest.runAttempt, 2);
  assert.equal(rerunEvidence.warnings[0].code, 'BOUND_CI_HAS_NEWER_RERUN');
  await expectCode(() => fetchCiBindingEvidence({
    client: clientFor(rerunRoutes), policy, commit, boundRunId: 500, boundRunAttempt: 1, requireLatest: true,
  }), 'SOURCE_RELEASE_CI_LATEST_DRIFT');
  testCount += 1;

  for (const laterState of [
    {status: 'completed', conclusion: 'failure'},
    {status: 'in_progress', conclusion: null},
  ]) {
    const laterRun = {
      ...ciRun({commit, runId: 500, attempt: 2}),
      status: laterState.status,
      conclusion: laterState.conclusion,
    };
    const laterJobs = ciJobs({runId: 500, attempt: 2}).map(job => ({
      ...job,
      status: laterState.status,
      conclusion: laterState.conclusion,
      completed_at: laterState.status === 'completed' ? job.completed_at : null,
    }));
    const laterRoutes = buildRemoteRoutes(fixture, {latestRun: laterRun, latestJobs: laterJobs});
    const immutableReadback = await fetchCiBindingEvidence({
      client: clientFor(laterRoutes),
      policy,
      commit,
      boundRunId: 500,
      boundRunAttempt: 1,
      requireLatest: false,
    });
    assert.equal(immutableReadback.bound.runAttempt, 1);
    assert.equal(immutableReadback.latest.runAttempt, 2);
    assert.equal(immutableReadback.warnings[0].code, 'BOUND_CI_HAS_NEWER_RERUN');
    await expectCode(() => fetchCiBindingEvidence({
      client: clientFor(laterRoutes),
      policy,
      commit,
      boundRunId: 500,
      boundRunAttempt: 1,
      requireLatest: true,
    }), 'SOURCE_RELEASE_CI_ATTEMPT_MISMATCH');
    testCount += 1;
  }

  const racedRoutes = buildRemoteRoutes(fixture, {
    mutableLatestRun: {...run, run_attempt: 2, status: 'in_progress', conclusion: null},
  });
  await expectCode(() => fetchCiBindingEvidence({
    client: clientFor(racedRoutes), policy, commit, boundRunId: 500, boundRunAttempt: 1, requireLatest: true,
  }), 'SOURCE_RELEASE_CI_LATEST_DRIFT');
  const racedPostPublish = await fetchCiBindingEvidence({
    client: clientFor(racedRoutes), policy, commit, boundRunId: 500, boundRunAttempt: 1, requireLatest: false,
  });
  assert.equal(racedPostPublish.warnings[0].code, 'LATEST_CI_ATTEMPT_RACED_READBACK');
  testCount += 1;

  const draftBody = [
    'Source release draft',
    buildPublicationJournal({
      state: SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY,
      tag: version,
      commit,
      attestationSha256,
    }),
  ].join('\n');
  const draftReady = decideSourceReleaseState(releaseStateFixture(fixture, {
    body: draftBody,
    draft: true,
    immutable: false,
    publishedAt: null,
  }));
  assert.equal(draftReady.publishState, SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY);
  const outcomeUnknown = decideSourceReleaseState(releaseStateFixture(fixture, {
    body: publishedBody,
    draft: true,
    immutable: false,
    publishedAt: null,
  }));
  assert.equal(outcomeUnknown.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN);
  assert.equal(outcomeUnknown.publish, false);
  const apiUnknown = decideSourceReleaseState({...releaseStateFixture(fixture), releaseReadOutcome: 'unknown'});
  assert.equal(apiUnknown.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN);
  const published = decideSourceReleaseState(releaseStateFixture(fixture));
  assert.equal(published.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED);
  const conflict = decideSourceReleaseState(releaseStateFixture(fixture, {immutable: false}));
  assert.equal(conflict.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_CONFLICT);
  testCount += 1;

  const markerFile = path.join(tmp, '.git', 'deployed_release.json');
  const recordOptions = {
    cwd: tmp,
    tag: version,
    expectedCommit: version,
    deploymentStateFile: markerFile,
    attestationFile,
    checksumFile,
    trustPolicyFile: path.join(tmp, 'config', 'source_release_trust_policy.json'),
    fetchImpl: fixtureFetch(buildRemoteRoutes(fixture)),
    githubApiUrl: 'https://api.github.test',
    now: () => new Date('2026-08-17T03:00:00Z'),
  };
  const recorded = await recordDeploymentRelease(recordOptions);
  assert.equal(recorded.deploymentMarker.schemaVersion, DEPLOYED_RELEASE_SCHEMA_VERSION_V3);
  assert.equal(recorded.deploymentMarker.remoteEvidence.releaseId, 700);
  assert.equal(validateDeployedReleaseMarker(recorded.deploymentMarker, {requireV3: true}).ok, true);
  const localRecorded = inspectRecordedDeploymentReleaseEvidence({
    cwd: tmp,
    marker: recorded.deploymentMarker,
    releaseAttestationRoot: attestationRoot,
    trustPolicyFile: path.join(tmp, 'config', 'source_release_trust_policy.json'),
  });
  assert.equal(localRecorded.ok, true, JSON.stringify(localRecorded));
  assert.equal(localRecorded.remoteEvidenceRole, 'cache-only');
  testCount += 1;

  const fullMarkerInputs = {
    repository: policy.repository.fullName,
    tag: version,
    commit,
    tagObject,
    attestation,
    attestationSha256,
    checksumSha256: sha256Hex(checksumBytes),
    trustPolicy: policy,
    trustPolicySha256: policySha256,
    remoteEvidence: remote,
    sourceFingerprint: clean.sourceFingerprint,
  };
  const builtMarker = buildDeployedReleaseMarker(fullMarkerInputs);
  assert.equal(builtMarker.schemaVersion, DEPLOYED_RELEASE_SCHEMA_VERSION_V3);
  assert.equal(validateDeployedReleaseMarker(builtMarker, {requireV3: true}).ok, true);
  for (const omitted of ['trustPolicy', 'trustPolicySha256', 'remoteEvidence', 'sourceFingerprint']) {
    assert.throws(
      () => buildDeployedReleaseMarker({...fullMarkerInputs, [omitted]: undefined}),
      error => error?.code === 'SOURCE_RELEASE_MARKER_V3_REQUIRED',
      `buildDeployedReleaseMarker must not silently build v2 when ${omitted} is missing`,
    );
  }
  testCount += 1;

  const forgedMarker = {
    ...recorded.deploymentMarker,
    remoteEvidence: {
      ...recorded.deploymentMarker.remoteEvidence,
      releaseId: 999,
    },
  };
  assert.equal(validateDeployedReleaseMarker(forgedMarker, {requireV3: true}).ok, true, 'well-formed local marker can be forged');
  const freshRemote = await verifyRemoteSourceReleaseEvidence({
    ...fixture,
    tag: version,
    trustPolicySha256: policySha256,
    client: clientFor(buildRemoteRoutes(fixture)),
  });
  assert.notEqual(forgedMarker.remoteEvidence.releaseId, freshRemote.releaseId, 'live remote evidence defeats whole local marker forgery');
  testCount += 1;

  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  let firstEnteredResolve;
  const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
  const lockMarker = path.join(tmp, '.git', 'lock-test-marker.json');
  const first = recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: lockMarker,
    hooks: {
      async beforePreMarkerSource() {
        firstEnteredResolve();
        await firstHeld;
      },
    },
  });
  await firstEntered;
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: lockMarker,
    lockTimeoutMs: 100,
  }), 'SOURCE_RELEASE_DEPLOYMENT_LOCKED');
  releaseFirst();
  await first;
  testCount += 1;

  const beforeToctouMarker = path.join(tmp, '.git', 'before-toctou.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: beforeToctouMarker,
    hooks: {beforeMarkerWrite: () => fs.writeFile(path.join(tmp, 'tracked.txt'), 'changed-before\n')},
  }), 'SOURCE_RELEASE_SOURCE_TOCTOU');
  assert.equal(await fs.stat(beforeToctouMarker).then(() => true, () => false), false);
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'v1\n');
  testCount += 1;

  const afterToctouMarker = path.join(tmp, '.git', 'after-toctou.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: afterToctouMarker,
    hooks: {afterMarkerWrite: () => fs.writeFile(path.join(tmp, 'tracked.txt'), 'changed-after\n')},
  }), 'SOURCE_RELEASE_SOURCE_TOCTOU');
  assert.equal(await fs.stat(afterToctouMarker).then(() => true, () => false), false, 'owned marker must be invalidated');
  await fs.writeFile(path.join(tmp, 'tracked.txt'), 'v1\n');
  testCount += 1;

  const casMarker = path.join(tmp, '.git', 'marker-cas.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: casMarker,
    hooks: {beforeMarkerWrite: () => fs.writeFile(casMarker, '{"external":true}\n')},
  }), 'SOURCE_RELEASE_MARKER_CAS_CONFLICT');
  assert.deepEqual(JSON.parse(await fs.readFile(casMarker, 'utf8')), {external: true});
  testCount += 1;

  const finalPublishRaceMarker = path.join(tmp, '.git', 'marker-final-publish-race.json');
  await fs.writeFile(finalPublishRaceMarker, '{"previous":true}\n');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: finalPublishRaceMarker,
    hooks: {beforeMarkerPublish: () => fs.writeFile(finalPublishRaceMarker, '{"concurrent":true}\n')},
  }), 'SOURCE_RELEASE_MARKER_CAS_CONFLICT');
  assert.deepEqual(
    JSON.parse(await fs.readFile(finalPublishRaceMarker, 'utf8')),
    {concurrent: true},
    'conditional publication must never overwrite the concurrent winner',
  );
  testCount += 1;

  // The first persisted readback after the atomic write must reuse the
  // open-verified bounded reader.  An attacker who swaps the marker path in
  // the write-to-readback window must fail the transaction closed instead of
  // being followed (symlink) or read unbounded (path swap / over-limit).
  const driftSwapMarker = path.join(tmp, '.git', 'marker-drift-swap.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: driftSwapMarker,
    hooks: {
      afterMarkerPersist: () => fs.rm(driftSwapMarker, {force: true})
        .then(() => fs.writeFile(driftSwapMarker, '{"forgedMarker":true}\n')),
    },
  }), 'SOURCE_RELEASE_MARKER_WRITE_INVALID');
  assert.deepEqual(
    JSON.parse(await fs.readFile(driftSwapMarker, 'utf8')),
    {forgedMarker: true},
    'post-publication replacement is external state and must not be deleted as an owned marker',
  );
  testCount += 1;

  const dirSwapMarker = path.join(tmp, '.git', 'marker-directory-swap.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: dirSwapMarker,
    hooks: {
      afterMarkerPersist: () => fs.rm(dirSwapMarker, {force: true}).then(() => fs.mkdir(dirSwapMarker)),
    },
  }), 'SOURCE_RELEASE_FILE_TYPE_INVALID');
  await fs.rm(dirSwapMarker, {recursive: true, force: true});
  testCount += 1;

  const oversizedSwapMarker = path.join(tmp, '.git', 'marker-oversized-swap.json');
  await expectCode(() => recordDeploymentRelease({
    ...recordOptions,
    deploymentStateFile: oversizedSwapMarker,
    hooks: {
      afterMarkerPersist: () => fs.rm(oversizedSwapMarker, {force: true})
        .then(() => fs.writeFile(oversizedSwapMarker, Buffer.alloc(DEPLOYMENT_MARKER_MAX_BYTES + 1, 0x61))),
    },
  }), 'SOURCE_RELEASE_FILE_SIZE_INVALID');
  await fs.rm(oversizedSwapMarker, {force: true});
  testCount += 1;

  const symlinkSwapMarker = path.join(tmp, '.git', 'marker-symlink-swap.json');
  const symlinkSwapTarget = path.join(tmp, '.git', 'marker-symlink-target.json');
  let symlinkSwapCreated = false;
  try {
    await fs.writeFile(symlinkSwapTarget, '{"forgedMarker":true}\n');
    await fs.symlink(symlinkSwapTarget, symlinkSwapMarker);
    symlinkSwapCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'EOPNOTSUPP'].includes(error?.code)) throw error;
  }
  if (symlinkSwapCreated) {
    // A fresh transaction starts with no marker at all (preflight CAS sees
    // ENOENT), so the write-to-readback hook is the only deterministic way to
    // place a symlink at the marker path.  The verify-then-swap steps above
    // only prove platform support for symlink creation.
    await fs.rm(symlinkSwapMarker);
    await expectCode(() => recordDeploymentRelease({
      ...recordOptions,
      deploymentStateFile: symlinkSwapMarker,
      hooks: {
        afterMarkerPersist: () => fs.rm(symlinkSwapMarker, {force: true})
          .then(() => fs.symlink(symlinkSwapTarget, symlinkSwapMarker)),
      },
    }), 'SOURCE_RELEASE_FILE_TYPE_INVALID');
    assert.equal(
      await fs.readlink(symlinkSwapMarker),
      symlinkSwapTarget,
      'failed readback must never follow the attacker symlink or trust its bytes',
    );
    await fs.rm(symlinkSwapMarker);
    await fs.rm(symlinkSwapTarget);
    testCount += 1;
  }

  git(tmp, ['update-index', '--skip-worktree', '--', 'tracked.txt']);
  await fs.rm(path.join(tmp, 'tracked.txt'));
  const hiddenMissing = inspectReleaseSourceState({cwd: tmp, expectedCommit: commit});
  assert.equal(hiddenMissing.ok, false);
  assert.deepEqual(hiddenMissing.hiddenIndexEntries, ['tracked.txt']);
  assert.deepEqual(hiddenMissing.missingTrackedFiles, ['tracked.txt']);
  testCount += 1;

  // Attestation verification must return and downstream reuse the exact
  // verified bytes.  The inspection path must never re-read the attestation
  // or checksum files from the path after verification (unbounded TOCTOU).
  const releaseStateSource = await fs.readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check_release_source_state.mjs'),
    'utf8',
  );
  assert.doesNotMatch(
    releaseStateSource,
    /readFileSync\(options\.attestationFile\)|readFileSync\(options\.checksumFile\)/u,
    'verification bytes must not be re-read from the path a second time',
  );
  testCount += 1;
  assert.doesNotMatch(
    releaseStateSource,
    /await fs\.readFile\(deploymentStateFile\)/u,
    'persisted marker readback must not re-read by unbounded pathname',
  );
  testCount += 1;

  console.log(JSON.stringify({
    ok: true,
    tests: testCount,
    markerSchema: DEPLOYED_RELEASE_SCHEMA_VERSION_V3,
    ciCompletedAtSource: 'exact-attempt-jobs',
  }, null, 2));
} finally {
  await fs.rm(tmp, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
}
