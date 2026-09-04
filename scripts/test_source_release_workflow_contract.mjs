#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectSourceReleaseVersionOrder} from '../lib/source_release_version.mjs';
import {
  buildPublicationJournal,
  decideSourceReleaseState,
  decideArmedDraftSourceReleaseState,
  deriveCiAttemptEvidence,
  SOURCE_RELEASE_PUBLISH_STATES,
  SOURCE_RELEASE_REQUIRED_CI_JOB_NAMES,
  stableJson,
  validateSourceReleaseTrustPolicy,
} from '../lib/source_release_github_evidence.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
const releasePath = path.join(repoRoot, '.github', 'workflows', 'source-release.yml');
const policyPath = path.join(repoRoot, 'config', 'source_release_trust_policy.json');
const ciSource = fs.readFileSync(ciPath, 'utf8');
const releaseSource = fs.readFileSync(releasePath, 'utf8');
const evidenceSource = fs.readFileSync(path.join(repoRoot, 'lib', 'source_release_github_evidence.mjs'), 'utf8');
const policy = validateSourceReleaseTrustPolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
let testCount = 0;

function dedent(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const indents = lines.filter(line => line.trim()).map(line => line.match(/^ */u)[0].length);
  const width = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map(line => line.slice(Math.min(width, line.length))).join('\n');
}

function extractMarked(source, begin, end) {
  const beginIndex = source.indexOf(begin);
  const endIndex = source.indexOf(end);
  assert.ok(beginIndex >= 0, `Missing marker: ${begin}`);
  assert.ok(endIndex > beginIndex, `Missing or misplaced marker: ${end}`);
  const contentStart = source.indexOf('\n', beginIndex);
  return dedent(source.slice(contentStart + 1, endIndex));
}

function loadFunction(source, name) {
  const context = vm.createContext({});
  new vm.Script(`${source}\nthis.__result = ${name};`, {filename: `${name}.contract.js`}).runInContext(context);
  assert.equal(typeof context.__result, 'function', `${name} was not extractable`);
  return (...args) => JSON.parse(JSON.stringify(context.__result(...args)));
}

function extractYamlLiteralRuns(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const parentIndent = match[1].length;
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() && line.match(/^ */u)[0].length <= parentIndent) break;
      body.push(line);
      cursor += 1;
    }
    blocks.push({line: index + 1, script: dedent(body.join('\n'))});
    index = cursor - 1;
  }
  return blocks;
}

function resolveGitBash() {
  const candidates = [];
  if (process.platform === 'win32') {
    const whereGit = spawnSync('where.exe', ['git.exe'], {encoding: 'utf8', windowsHide: true, timeout: 5000});
    const roots = whereGit.status === 0
      ? String(whereGit.stdout).split(/\r?\n/u).filter(Boolean).map(git => path.dirname(path.dirname(git)))
      : [];
    candidates.push(
      process.env.GIT_BASH,
      ...roots.flatMap(root => [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    );
  } else {
    candidates.push('/bin/bash', 'bash');
  }
  for (const candidate of candidates.filter(Boolean)) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], {encoding: 'utf8', windowsHide: true, timeout: 5000});
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error('Git Bash/bash is required for embedded workflow syntax checks');
}

function exactWorkflowJobDisplayName(source, jobId) {
  const matches = [...source.matchAll(new RegExp(`^  ${jobId}:\\r?\\n    name: ([^\\r\\n]+)$`, 'gmu'))];
  assert.equal(matches.length, 1, `Expected exactly one display name for CI job ${jobId}`);
  return matches[0][1];
}

function requiredJobDisplayNamesFromCi(source) {
  const shardRows = [...source.matchAll(/^        shard: \[([^\r\n]+)\]$/gmu)];
  assert.equal(shardRows.length, 1, 'Expected exactly one deterministic shard matrix');
  const shards = [...shardRows[0][1].matchAll(/'([^']+)'/gu)].map(match => match[1]);
  assert.deepEqual(shards, ['1/4', '2/4', '3/4', '4/4']);
  const shardTemplate = exactWorkflowJobDisplayName(source, 'deterministic-shards');
  return [
    exactWorkflowJobDisplayName(source, 'source-checks'),
    ...shards.map(shard => shardTemplate.replace('${{ matrix.shard }}', shard)),
    exactWorkflowJobDisplayName(source, 'release-gate'),
    exactWorkflowJobDisplayName(source, 'ci-terminal'),
  ];
}

assert.equal(policy.repository.id, 1228612468);
assert.equal(policy.repository.fullName, 'dushengyi1993/shein-sales-bi');
assert.equal(policy.ci.workflowPath, '.github/workflows/ci.yml');
assert.deepEqual(policy.ci.requiredJobNames, requiredJobDisplayNamesFromCi(ciSource));
assert.deepEqual(policy.ci.requiredJobNames, SOURCE_RELEASE_REQUIRED_CI_JOB_NAMES);
assert.deepEqual(policy.ci.allowedJobConclusions, ['success']);
assert.equal(policy.sourceRelease.workflowPath, '.github/workflows/source-release.yml');
assert.equal(policy.sourceRelease.requireImmutableReleases, true);
assert.equal(policy.sourceRelease.requireOwnerEnforcement, false);
testCount += 1;

const {requiredJobNames: omittedRequiredJobNames, ...ciWithoutRequiredJobNames} = policy.ci;
assert.equal(omittedRequiredJobNames.length, 7);
assert.throws(
  () => validateSourceReleaseTrustPolicy({...policy, ci: ciWithoutRequiredJobNames}),
  /trust policy CI keys are not exact/u,
  'requiredJobNames must be a mandatory exact CI policy key',
);
testCount += 1;

for (const [label, requiredJobNames] of [
  ['duplicate', [...policy.ci.requiredJobNames.slice(0, -1), policy.ci.requiredJobNames[0]]],
  ['renamed', policy.ci.requiredJobNames.map(name => name === 'Release gate' ? 'Release and CI gate' : name)],
]) {
  assert.throws(
    () => validateSourceReleaseTrustPolicy({...policy, ci: {...policy.ci, requiredJobNames}}),
    /Tracked source release trust policy is invalid/u,
    `${label} required display names must fail policy validation`,
  );
  testCount += 1;
}

assert.throws(
  () => validateSourceReleaseTrustPolicy({
    ...policy,
    ci: {...policy.ci, allowedJobConclusions: ['success', 'skipped']},
  }),
  /Tracked source release trust policy is invalid/u,
  'source releases must reject any skipped CI job instead of treating it as a terminal success',
);
testCount += 1;

assert.throws(
  () => validateSourceReleaseTrustPolicy({
    ...policy,
    sourceRelease: {...policy.sourceRelease, requireOwnerEnforcement: 'false'},
  }),
  /Tracked source release trust policy is invalid/u,
  'owner enforcement policy must remain an explicit boolean',
);
testCount += 1;

const exactCommit = 'b'.repeat(40);
const exactRun = {
  id: 301,
  run_attempt: 4,
  head_sha: exactCommit,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  html_url: 'https://github.com/dushengyi1993/shein-sales-bi/actions/runs/301',
  status: 'completed',
  conclusion: 'success',
};
const exactJobs = policy.ci.requiredJobNames.map((name, index) => ({
  id: 3001 + index,
  name,
  run_id: exactRun.id,
  run_attempt: exactRun.run_attempt,
  status: 'completed',
  conclusion: 'success',
  completed_at: `2026-08-17T01:${String(index).padStart(2, '0')}:00Z`,
}));
const exactEvidence = deriveCiAttemptEvidence({
  run: exactRun,
  jobs: exactJobs,
  policy,
  expectedCommit: exactCommit,
  expectedRunId: exactRun.id,
  expectedRunAttempt: exactRun.run_attempt,
});
const normalizedExactJobs = exactJobs.map(job => ({
  id: job.id,
  name: job.name,
  runId: job.run_id,
  runAttempt: job.run_attempt,
  status: job.status,
  conclusion: job.conclusion,
  completedAt: job.completed_at,
}));
const expectedJobsSha256 = crypto.createHash('sha256').update(`${stableJson({
  jobs: normalizedExactJobs,
  requiredJobs: normalizedExactJobs,
})}\n`).digest('hex');
assert.equal(exactEvidence.jobCount, 7);
assert.equal(exactEvidence.completedAt, exactJobs.at(-1).completed_at);
assert.equal(exactEvidence.jobsSha256, expectedJobsSha256);
assert.equal(deriveCiAttemptEvidence({
  run: exactRun,
  jobs: [...exactJobs].reverse(),
  policy,
  expectedCommit: exactCommit,
  expectedRunId: exactRun.id,
  expectedRunAttempt: exactRun.run_attempt,
}).jobsSha256, expectedJobsSha256, 'job response order must not change the normalized digest');
const completionDrift = exactJobs.map((job, index) => index === 0
  ? {...job, completed_at: '2026-08-17T01:07:00Z'}
  : job);
assert.notEqual(deriveCiAttemptEvidence({
  run: exactRun,
  jobs: completionDrift,
  policy,
  expectedCommit: exactCommit,
  expectedRunId: exactRun.id,
  expectedRunAttempt: exactRun.run_attempt,
}).jobsSha256, expectedJobsSha256, 'required-job terminal evidence must be bound into jobsSha256');
testCount += 1;

const requiredJobFailures = [
  ['missing', exactJobs.slice(0, -1), 'SOURCE_RELEASE_CI_REQUIRED_JOB_MISSING'],
  ['duplicate', [...exactJobs, {...exactJobs[0], id: 3999}], 'SOURCE_RELEASE_CI_REQUIRED_JOB_DUPLICATE'],
  ['renamed/merged', exactJobs.map((job, index) => index === 1 ? {...job, name: 'Deterministic shards 1/4 + 2/4'} : job), 'SOURCE_RELEASE_CI_REQUIRED_JOB_MISSING'],
  ['failed', exactJobs.map((job, index) => index === 5 ? {...job, conclusion: 'failure'} : job), 'SOURCE_RELEASE_CI_JOB_FAILED'],
  ['incomplete', exactJobs.map((job, index) => index === 6 ? {...job, status: 'in_progress', conclusion: null, completed_at: null} : job), 'SOURCE_RELEASE_CI_JOBS_INCOMPLETE'],
  ['wrong run', exactJobs.map((job, index) => index === 0 ? {...job, run_id: 302} : job), 'SOURCE_RELEASE_CI_JOB_ATTEMPT_MISMATCH'],
  ['wrong attempt', exactJobs.map((job, index) => index === 0 ? {...job, run_attempt: 5} : job), 'SOURCE_RELEASE_CI_JOB_ATTEMPT_MISMATCH'],
];
for (const [label, jobs, code] of requiredJobFailures) {
  assert.throws(
    () => deriveCiAttemptEvidence({
      run: exactRun,
      jobs,
      policy,
      expectedCommit: exactCommit,
      expectedRunId: exactRun.id,
      expectedRunAttempt: exactRun.run_attempt,
    }),
    error => error?.code === code,
    label,
  );
  testCount += 1;
}

const trustedValidator = loadFunction(extractMarked(
  ciSource,
  '// TRUSTED_CI_EVIDENCE_VALIDATOR_BEGIN',
  '// TRUSTED_CI_EVIDENCE_VALIDATOR_END',
), 'validateTrustedCiEvidence');
const trustedSha = 'a'.repeat(40);
const currentSha = 'c'.repeat(40);
const candidate = {
  id: 101,
  run_attempt: 2,
  head_sha: trustedSha,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  html_url: 'https://github.com/example/actions/runs/101',
  status: 'completed',
  conclusion: 'success',
  completed_at: null,
};
const trustedJob = {
  id: 1001,
  name: 'deterministic-tests',
  run_id: 101,
  run_attempt: 2,
  head_sha: trustedSha,
  status: 'completed',
  conclusion: 'success',
  completed_at: '2026-08-17T01:02:03Z',
};
const trustedEvidence = trustedValidator({
  candidate,
  exactAttempt: {...candidate},
  latestRun: {...candidate},
  jobPages: [{total_count: 1, jobs: [trustedJob]}],
  currentRunId: 200,
  currentSha,
});
assert.equal(trustedEvidence.completedAt, trustedJob.completed_at);
assert.equal(trustedEvidence.jobCount, 1);
testCount += 1;

for (const [label, job, fragment] of [
  ['incomplete', {...trustedJob, status: 'in_progress', conclusion: null}, 'not completed+success'],
  ['failed', {...trustedJob, conclusion: 'failure'}, 'not completed+success'],
  ['attempt drift', {...trustedJob, run_attempt: 3}, 'does not match the trusted run'],
]) {
  assert.throws(() => trustedValidator({
    candidate,
    exactAttempt: {...candidate},
    latestRun: {...candidate},
    jobPages: [{total_count: 1, jobs: [job]}],
    currentRunId: 200,
    currentSha,
  }), error => String(error?.message || error).includes(fragment), label);
  testCount += 1;
}

const baselineHelper = extractMarked(
  ciSource,
  '// PARTNER_CLI_BASELINE_STATE_MACHINE_BEGIN',
  '// PARTNER_CLI_BASELINE_STATE_MACHINE_END',
);
const decidePartnerCliBaselineState = loadFunction(baselineHelper, 'decidePartnerCliBaselineState');
const baseline = decidePartnerCliBaselineState({
  currentSha,
  before: {sha: '0'.repeat(40), allZero: true, resolvable: false, resolvedCommit: ''},
  trusted: {
    sha: trustedSha,
    runId: 101,
    runAttempt: 2,
    url: candidate.html_url,
    completedAt: trustedEvidence.completedAt,
    status: 'completed',
    conclusion: 'success',
    fetched: true,
  },
});
assert.deepEqual(baseline.bases, [trustedSha]);
assert.equal(baseline.beforeMode, 'all-zero-trusted-fallback');
testCount += 1;

assert.ok(ciSource.includes('/attempts/$trusted_run_attempt/jobs?per_page=100'));
assert.ok(ciSource.includes('TRUSTED_CI_EVIDENCE_VALIDATOR_BEGIN'));
assert.ok(ciSource.includes('job.completed_at'));
assert.doesNotMatch(ciSource, /candidate\.completed_at|exactAttempt\.completed_at|latestRun\.completed_at/u);
testCount += 1;

const version = '2026.08.17.7';
const commit = 'd'.repeat(40);
const attestationSha256 = '1'.repeat(64);
const expectedAssets = {
  'release-attestation.json': {size: 700, digest: `sha256:${'2'.repeat(64)}`},
  'release-attestation.json.sha256': {size: 91, digest: `sha256:${'3'.repeat(64)}`},
};
const assets = [
  {id: 701, name: 'release-attestation.json', state: 'uploaded', ...expectedAssets['release-attestation.json']},
  {id: 702, name: 'release-attestation.json.sha256', state: 'uploaded', ...expectedAssets['release-attestation.json.sha256']},
];
const journal = state => buildPublicationJournal({state, tag: version, commit, attestationSha256});
const stateFixture = release => ({
  version,
  expectedCommit: commit,
  observedMain: commit,
  expectedTitle: `SHEIN BI Ops ${version}`,
  attestationSha256,
  expectedAssets,
  tag: {exists: true, type: 'tag', peeledCommit: commit, messageMatches: true},
  release,
});
const draftReady = decideSourceReleaseState(stateFixture({
  exists: true,
  id: 700,
  tagName: version,
  title: `SHEIN BI Ops ${version}`,
  body: journal(SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY),
  draft: true,
  prerelease: false,
  immutable: false,
  publishedAt: null,
  assets,
}));
assert.equal(draftReady.publishState, SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY);
const unknown = decideSourceReleaseState(stateFixture({
  exists: true,
  id: 700,
  tagName: version,
  title: `SHEIN BI Ops ${version}`,
  body: journal(SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN),
  draft: true,
  prerelease: false,
  immutable: false,
  publishedAt: null,
  assets,
}));
assert.equal(unknown.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN);
const verified = decideSourceReleaseState(stateFixture({
  exists: true,
  id: 700,
  tagName: version,
  title: `SHEIN BI Ops ${version}`,
  body: journal(SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN),
  draft: false,
  prerelease: false,
  immutable: true,
  publishedAt: '2026-08-17T02:00:00Z',
  assets,
}));
assert.equal(verified.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED);
const conflict = decideSourceReleaseState(stateFixture({
  exists: true,
  id: 700,
  tagName: version,
  title: `SHEIN BI Ops ${version}`,
  body: journal(SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN),
  draft: false,
  prerelease: false,
  immutable: false,
  publishedAt: '2026-08-17T02:00:00Z',
  assets,
}));
assert.equal(conflict.publishState, SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_CONFLICT);
testCount += 1;

// ---- Armed draft pre-publish re-verification (full gate) ----
const releaseId = 700;
const armedUnknownBody = ['Release ' + version, '', 'Commit: ' + commit, 'Required main push CI', journal(SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN), ''].join('\n');
const armedJournal = () => journal(SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN);
const armedState = (release, {
  expectedReleaseId = releaseId,
  expectedArmedBody = armedUnknownBody,
  observedMain = commit,
  tag = {exists: true, type: 'tag', peeledCommit: commit, messageMatches: true},
  expectedAssetsOverride = expectedAssets,
} = {}) => ({
  version,
  expectedCommit: commit,
  observedMain,
  expectedTitle: 'SHEIN BI Ops ' + version,
  attestationSha256,
  expectedReleaseId,
  expectedArmedBody,
  expectedAssets: expectedAssetsOverride,
  tag,
  release,
});
const armedConsistent = {
  exists: true,
  id: releaseId,
  tagName: version,
  title: 'SHEIN BI Ops ' + version,
  body: armedUnknownBody,
  draft: true,
  prerelease: false,
  immutable: false,
  publishedAt: null,
  assets,
};
const armedReady = decideArmedDraftSourceReleaseState(armedState(armedConsistent));
assert.equal(armedReady.mode, 'armed-draft', 'a fully consistent armed draft must clear the single publish');
assert.equal(armedReady.publish, true, 'the publish flag must be granted only after full re-verification success');
assert.equal(armedReady.terminalReadOnly, false);
assert.equal(
  decideSourceReleaseState(stateFixture(armedConsistent)).publishState,
  SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
  'the existing state machine must keep treating an armed draft as terminal read-only outcome-unknown',
);
testCount += 1;

const legacyPrePublishPredicate = (candidate, expectedId) => (
  candidate?.id === expectedId && candidate?.draft === true
);
const armedDriftCases = [
  ['id drifted', {...armedConsistent, id: releaseId + 1}],
  ['draft already published', {...armedConsistent, draft: false}],
  ['title drifted', {...armedConsistent, title: 'SHEIN BI Ops OTHER'}],
  ['tag_name drifted', {...armedConsistent, tagName: '2026.08.17.8'}],
  ['publication journal missing', {...armedConsistent, body: armedUnknownBody.replace(armedJournal(), 'no journal')}],
  ['duplicate publication journal', {...armedConsistent, body: armedUnknownBody + '\n' + armedJournal()}],
  ['wrong publication journal state', {...armedConsistent, body: armedUnknownBody.replace(armedJournal(), journal(SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY))}],
  ['publication journal identity drifted', {...armedConsistent, body: armedUnknownBody.replace(armedJournal(), buildPublicationJournal({state: SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN, tag: version, commit: 'e'.repeat(40), attestationSha256}))}],
  ['body drifted outside the journal', {...armedConsistent, body: armedUnknownBody + '\ntrailing content'}],
  ['prerelease flag drifted', {...armedConsistent, prerelease: true}],
  ['immutable flag drifted', {...armedConsistent, immutable: true}],
  ['published_at non-null on draft', {...armedConsistent, publishedAt: '2026-08-17T02:00:00Z'}],
  ['asset metadata drifted', {...armedConsistent, assets: [assets[0]]}],
];
let legacyApproved = 0;
for (const [label, releaseOf] of armedDriftCases) {
  const gate = decideArmedDraftSourceReleaseState(armedState(releaseOf));
  assert.equal(gate.publish, false, 'new armed gate must reject: ' + label);
  assert.equal(gate.mode, 'armed-draft-conflict', 'new armed gate must fail closed: ' + label);
  if (legacyPrePublishPredicate(releaseOf, releaseId)) legacyApproved += 1;
  testCount += 1;
}
assert.ok(legacyApproved >= 9, 'the pre-fix id+draft gate would have approved drifts the new gate rejects');

assert.equal(decideArmedDraftSourceReleaseState(armedState(armedConsistent, {expectedReleaseId: 0})).publish, false, 'an invalid armed release id binding must fail closed');
assert.equal(decideArmedDraftSourceReleaseState(armedState(armedConsistent, {expectedArmedBody: ''})).publish, false, 'an invalid armed unknown-outcome body binding must fail closed');
assert.equal(decideArmedDraftSourceReleaseState(armedState(armedConsistent, {tag: {exists: true, type: 'tag', peeledCommit: 'a'.repeat(40), messageMatches: false}})).publish, false, 'an armed draft whose annotated tag drifted must fail closed');
assert.equal(decideArmedDraftSourceReleaseState(armedState({exists: false})).publish, false, 'a missing armed release readback must fail closed');
assert.throws(
  () => decideArmedDraftSourceReleaseState(armedState(armedConsistent, {observedMain: 'a'.repeat(40)})),
  error => error?.code === 'SOURCE_RELEASE_MAIN_DRIFT',
  'an origin/main drift must fail the armed gate',
);
assert.throws(
  () => decideArmedDraftSourceReleaseState({...armedState(armedConsistent), expectedCommit: null}),
  error => error?.code === 'SOURCE_RELEASE_STATE_INVALID',
  'an invalid expected commit must fail the armed gate',
);
testCount += 1;

for (const needle of [
  'armed-draft',
  'Armed draft release id drifted',
  'Armed draft tag_name drifted',
  'Armed draft title drifted',
  'Armed draft is no longer an unpublished draft',
  'Armed draft prerelease flag drifted',
  'Armed draft immutable flag drifted',
  'Armed draft published_at is not null',
  'Armed draft publication journal is',
  'not the unique unknown-outcome journal',
  'Armed draft body drifted',
  'Armed draft expected assets are not exact',
]) {
  assert.ok(evidenceSource.includes(needle), 'armed re-verification must encode: ' + needle);
}
assert.ok(releaseSource.includes('decideArmedDraftSourceReleaseState'), 'workflow must import the armed re-verifier');
assert.ok(releaseSource.includes("command === 'armed'"), 'workflow must decode armed drafts via the dedicated cli command');
assert.ok(releaseSource.includes('expectedReleaseId'), 'workflow must bind the armed release id into the re-verification');
assert.ok(releaseSource.includes('expectedArmedBody'), 'workflow must bind the unknown-outcome body into the re-verification');
assert.ok(releaseSource.includes('Armed draft re-verification failed before the single publish PATCH'), 'armed gate must fail closed with a diagnostic');
assert.doesNotMatch(releaseSource, /Armed draft identity changed before publish/u, 'the pre-fix id+draft-only gate must be removed');
const armedGateMarker = releaseSource.indexOf('state-armed.json');
const publishPatchMarker = releaseSource.indexOf('--request PATCH');
assert.ok(releaseSource.indexOf('download_and_compare_assets immediately-before-publish') < armedGateMarker, 'asset byte download must finish before the final tight armed gate');
assert.ok(releaseSource.indexOf('verify_repository_trust immediately-before-publish') < armedGateMarker, 'repository trust preflight must finish before the final tight armed gate');
assert.ok(releaseSource.indexOf('refresh_bound_ci true immediately-before-publish') < armedGateMarker, 'CI binding preflight must finish before the final tight armed gate');
assert.ok(releaseSource.indexOf('assert_tag_exact immediately-before-publish') < armedGateMarker, 'a fresh tag re-assert must precede the final armed gate');
assert.ok(armedGateMarker < publishPatchMarker, 'the full armed gate must precede the single draft=false PATCH');
const gateToPatch = releaseSource.slice(armedGateMarker, publishPatchMarker);
for (const forbidden of ['download_and_compare_assets', 'inspect_release', 'assert_tag_exact', 'verify_repository_trust', 'refresh_bound_ci', 'fetch_main_head', 'gh_json']) {
  assert.equal(gateToPatch.includes(forbidden), false, 'no ' + forbidden + ' may run between the full armed gate and the draft=false PATCH');
}
assert.ok(releaseSource.includes('/releases/$armed_release_id'), 'the single publish PATCH must target the armed gate release id');
assert.ok(releaseSource.includes('Armed gate release id'), 'the armed gate release id must be bound with an equality assertion');
assert.equal((releaseSource.match(/--request PATCH/g) || []).length, 1, 'the draft=false publish PATCH must remain unique');
testCount += 1;
for (const [requestedVersion, remoteRefs, expectedMode] of [
  ['2026.08.17.7', [], 'advance'],
  ['2026.08.17.10', [`${'a'.repeat(40)}\trefs/tags/2026.08.17.10`], 'recover-latest'],
  ['2026.08.18.1', [`${'a'.repeat(40)}\trefs/tags/2026.08.17.99`], 'advance'],
]) {
  assert.equal(inspectSourceReleaseVersionOrder({requestedVersion, remoteRefs}).mode, expectedMode);
  testCount += 1;
}
assert.throws(() => inspectSourceReleaseVersionOrder({
  requestedVersion: '2026.08.17.6',
  remoteRefs: [`${'a'.repeat(40)}\trefs/tags/2026.08.17.7`],
}), /behind current latest source tag/u);
testCount += 1;

const attestationTemplate = extractMarked(
  releaseSource,
  '# SOURCE_RELEASE_ATTESTATION_V3_BEGIN',
  '# SOURCE_RELEASE_ATTESTATION_V3_END',
);
assert.match(attestationTemplate, /schemaVersion:3/u);
assert.match(attestationTemplate, /jobsSha256/u);
assert.match(attestationTemplate, /jobCount/u);
assert.match(attestationTemplate, /trustPolicySha256/u);
assert.doesNotMatch(attestationTemplate, /GITHUB_RUN_ID|generatedAt/u);
testCount += 1;

const releaseFragments = [
  'config/source_release_trust_policy.json',
  'fetchLatestCiBindingEvidence',
  'fetchCiBindingEvidence',
  'fetchRepositoryTrustEvidence',
  'verifyRemoteSourceReleaseEvidence',
  '/releases?per_page=100',
  'DRAFT_READY',
  'PUBLISH_OUTCOME_UNKNOWN',
  'PUBLISHED_VERIFIED',
  'PUBLISHED_CONFLICT',
  'immediately-before-publish',
  'no automatic publish retry is allowed',
  'Never retry or PATCH back to draft',
  'Accept: application/octet-stream',
  'check_source_release_version_order.mjs',
  'exact-attempt jobs',
];
for (const fragment of releaseFragments) {
  assert.ok(releaseSource.includes(fragment), `Source release contract missing: ${fragment}`);
}
assert.match(
  releaseSource,
  /\[ "\$ci_completed_epoch" -le "\$published_epoch" \]/u,
  'same-second exact-attempt CI completion must be accepted by the publication time gate',
);
assert.doesNotMatch(
  releaseSource,
  /-lt "\$published_epoch"/u,
  'the strict ci<published gate must be removed',
);
assert.match(
  releaseSource,
  /complete no later than publication/u,
  'the time-gate diagnostic must describe the non-strict at-or-before invariant',
);
assert.ok(
  releaseSource.indexOf('remote-terminal.json') < releaseSource.indexOf('ci_completed_epoch'),
  'exact-attempt CI completion must be proven before the publication time gate',
);
assert.doesNotMatch(releaseSource, /\bgh\s+release\s+create\b/u);
assert.doesNotMatch(releaseSource, /run\.completed_at|candidate\.completed_at|exactAttempt\.completed_at/u);
assert.ok(evidenceSource.includes('/immutable-releases'));
const partnerWorkflowPath = path.join(repoRoot, '.github', 'workflows', 'partner-cli-release.yml');
const partnerWorkflowSource = fs.readFileSync(partnerWorkflowPath, 'utf8');
const releaseCredentialPriorityExpression = 'GH_TOKEN: ${{ secrets.SOURCE_RELEASE_ADMIN_TOKEN || github.token }}';
const credentialDeclaration = /GH_TOKEN: \$\{\{[^}]*\}\}/gu;
const releaseCredentialDeclarations = releaseSource.match(credentialDeclaration) || [];
const partnerCredentialDeclarations = partnerWorkflowSource.match(credentialDeclaration) || [];
assert.ok(releaseCredentialDeclarations.length > 0, 'source-release.yml must declare GH_TOKEN');
assert.ok(
  releaseCredentialDeclarations.every(expression => expression === releaseCredentialPriorityExpression),
  'every source-release GH_TOKEN declaration must prefer SOURCE_RELEASE_ADMIN_TOKEN with github.token fallback',
);
assert.ok(
  partnerCredentialDeclarations.length > 0,
  'partner-cli-release.yml must declare GH_TOKEN',
);
assert.ok(
  partnerCredentialDeclarations.every(expression => expression === releaseCredentialPriorityExpression),
  'partner-cli-release.yml must use the exact same credential priority expression as source-release.yml',
);
assert.doesNotMatch(releaseSource, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
assert.doesNotMatch(partnerWorkflowSource, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
assert.ok(evidenceSource.includes('/attempts/${runAttempt}/jobs?filter=all'));
assert.equal((releaseSource.match(/--request PATCH/g) || []).length, 1, 'only one irreversible publish PATCH may exist');
assert.ok(releaseSource.indexOf('journal PUBLISH_OUTCOME_UNKNOWN') < releaseSource.indexOf('--request PATCH'));
testCount += 1;

// ---- evaluateInspectRelease contract & regression tests ----
const evaluateInspectRelease = loadFunction(extractMarked(
  releaseSource,
  '// INSPECT_RELEASE_EVALUATOR_BEGIN',
  '// INSPECT_RELEASE_EVALUATOR_END',
), 'evaluateInspectRelease');
const readExpectedReleaseIdentityFiles = loadFunction(extractMarked(
  releaseSource,
  '// EXPECTED_RELEASE_IDENTITY_READER_BEGIN',
  '// EXPECTED_RELEASE_IDENTITY_READER_END',
), 'readExpectedReleaseIdentityFiles');

const defaultExpectedTitle = `SHEIN BI Ops ${version}`;
const baseInspectParams = {
  version,
  expectedCommit: commit,
  expectedTitle: defaultExpectedTitle,
  expectedAssets,
  expectedUnknownBody: armedUnknownBody,
};

// Test Case 1: Normal exact-tag path (published and draft)
const normalExactPublished = {
  id: 700,
  tag_name: version,
  name: defaultExpectedTitle,
  body: armedUnknownBody,
  draft: false,
  prerelease: false,
  immutable: true,
  published_at: '2026-08-17T02:00:00Z',
  html_url: `https://github.com/dushengyi1993/shein-sales-bi/releases/tag/${version}`,
  assets,
};
const inspectedPublished = evaluateInspectRelease({...baseInspectParams, releases: [normalExactPublished]});
assert.equal(inspectedPublished.exists, true);
assert.equal(inspectedPublished.id, 700);
assert.equal(inspectedPublished.tagName, version);
assert.equal(inspectedPublished.draft, false);
testCount += 1;

const normalExactDraft = {
  id: 700,
  tag_name: version,
  name: defaultExpectedTitle,
  body: armedUnknownBody,
  draft: true,
  prerelease: false,
  immutable: false,
  published_at: null,
  html_url: `https://github.com/dushengyi1993/shein-sales-bi/releases/tag/${version}`,
  assets,
};
const inspectedExactDraft = evaluateInspectRelease({...baseInspectParams, releases: [normalExactDraft]});
assert.equal(inspectedExactDraft.exists, true);
assert.equal(inspectedExactDraft.id, 700);
assert.equal(inspectedExactDraft.tagName, version);
assert.equal(inspectedExactDraft.draft, true);
testCount += 1;

// Test Case 2: Duplicate exact-tag releases fail closed
assert.throws(
  () => evaluateInspectRelease({
    ...baseInspectParams,
    releases: [normalExactDraft, {...normalExactDraft, id: 701}],
  }),
  /duplicate GitHub Releases for exact tag/u,
  'duplicate exact tag releases must throw duplicate error',
);
testCount += 1;

// Test Case 3: Unique immutable untagged draft recovery
const untaggedDraft = {
  id: 750,
  tag_name: 'untagged-abcdef0123456789',
  target_commitish: commit,
  name: defaultExpectedTitle,
  body: armedUnknownBody,
  draft: true,
  prerelease: false,
  immutable: false,
  published_at: null,
  html_url: `https://github.com/dushengyi1993/shein-sales-bi/releases/tag/untagged-abcdef0123456789`,
  assets,
};
const inspectedUntagged = evaluateInspectRelease({...baseInspectParams, releases: [untaggedDraft]});
assert.equal(inspectedUntagged.exists, true);
assert.equal(inspectedUntagged.id, 750);
assert.equal(inspectedUntagged.tagName, version, 'recovered draft tagName must be normalized to expected version');
assert.equal(inspectedUntagged.draft, true);
assert.equal(inspectedUntagged.title, defaultExpectedTitle);
assert.equal(inspectedUntagged.body, armedUnknownBody);
assert.equal(inspectedUntagged.assets.length, 2);

// Feed recovered draft into armed draft state machine
const armedGateFromUntagged = decideArmedDraftSourceReleaseState(armedState(inspectedUntagged, {expectedReleaseId: 750}));
assert.equal(armedGateFromUntagged.mode, 'armed-draft');
assert.equal(armedGateFromUntagged.publish, true);
assert.equal(armedGateFromUntagged.releaseId, 750);
testCount += 1;

const exactDraftReady = {
  ...normalExactDraft,
  target_commitish: commit,
  body: journal(SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY),
};
assert.throws(
  () => evaluateInspectRelease({...baseInspectParams, releases: [exactDraftReady, untaggedDraft]}),
  /exact release has an ambiguous immutable untagged sibling/u,
  'an exact DRAFT_READY release must not hide a same-identity untagged UNKNOWN sibling',
);
testCount += 1;

const titleDriftedUntaggedSibling = {
  ...untaggedDraft,
  id: 753,
  name: 'SHEIN BI Ops drifted sibling title',
};
assert.throws(
  () => evaluateInspectRelease({...baseInspectParams, releases: [exactDraftReady, titleDriftedUntaggedSibling]}),
  /exact release has an ambiguous immutable untagged sibling/u,
  'an exact DRAFT_READY release must reject an untagged sibling anchored by exact UNKNOWN body and assets',
);
testCount += 1;

// Test Case 4: Ambiguous / duplicate untagged drafts fail closed
assert.throws(
  () => evaluateInspectRelease({
    ...baseInspectParams,
    releases: [untaggedDraft, {...untaggedDraft, id: 751, tag_name: 'untagged-other123456789'}],
  }),
  /duplicate or ambiguous release drafts/u,
  'multiple untagged drafts with same title must fail closed',
);
assert.throws(
  () => evaluateInspectRelease({
    ...baseInspectParams,
    releases: [untaggedDraft, {...untaggedDraft, id: 752, name: 'SHEIN BI Ops other', tag_name: 'untagged-other2'}],
  }),
  /duplicate or ambiguous release drafts/u,
  'multiple untagged drafts with same armed body must fail closed',
);
testCount += 1;

// Test Case 5: Unmatched / drifted untagged drafts fail closed
const untaggedDriftCases = [
  ['target commit drifted', {...untaggedDraft, target_commitish: 'e'.repeat(40)}],
  ['title and body drifted while target and assets remain exact', {
    ...untaggedDraft,
    name: 'SHEIN BI Ops drifted',
    body: 'drifted body',
  }],
  ['tag_name is wrong explicit non-untagged tag', {...untaggedDraft, tag_name: 'v2026.08.17.99'}],
  ['tag_name is bare untagged prefix without suffix', {...untaggedDraft, tag_name: 'untagged-'}],
  ['tag_name is empty string', {...untaggedDraft, tag_name: ''}],
  ['tag_name is null/non-string', {...untaggedDraft, tag_name: null}],
  ['body drifted outside journal', {...untaggedDraft, body: armedUnknownBody + ' trailing'}],
  ['journal state is draft-ready instead of unknown', {...untaggedDraft, body: journal(SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY)}],
  ['assets missing', {...untaggedDraft, assets: [assets[0]]}],
  ['asset size mismatched', {...untaggedDraft, assets: [{...assets[0], size: 999}, assets[1]]}],
  ['asset digest mismatched', {...untaggedDraft, assets: [{...assets[0], digest: 'sha256:bad'}, assets[1]]}],
  ['draft is false on untagged', {...untaggedDraft, draft: false}],
  ['prerelease is true on untagged', {...untaggedDraft, prerelease: true}],
  ['exact body remains related even when release is not a draft', {
    ...untaggedDraft,
    draft: false,
    name: 'SHEIN BI Ops unrelated title',
    target_commitish: 'e'.repeat(40),
    assets: [],
  }],
];
for (const [label, driftedRelease] of untaggedDriftCases) {
  assert.throws(
    () => evaluateInspectRelease({...baseInspectParams, releases: [driftedRelease]}),
    /does not satisfy exact immutable draft contract/u,
    'drifted untagged draft must fail closed: ' + label,
  );
  testCount += 1;
}

// Test Case 6: Non-existent release
assert.deepEqual(evaluateInspectRelease({...baseInspectParams, releases: []}), {exists: false});
assert.deepEqual(evaluateInspectRelease({
  ...baseInspectParams,
  releases: [{
    ...normalExactPublished,
    tag_name: '2026.08.16.1',
    name: 'SHEIN BI Ops 2026.08.16.1',
    body: 'historical release body',
    assets: [],
  }],
}), {exists: false});
testCount += 1;

const targetOnlyHistoricalRelease = {
  ...normalExactPublished,
  id: 699,
  tag_name: '2026.08.16.2',
  target_commitish: commit,
  name: 'SHEIN BI Ops 2026.08.16.2',
  body: 'unrelated historical release body',
  assets: [],
};
assert.deepEqual(
  evaluateInspectRelease({...baseInspectParams, releases: [targetOnlyHistoricalRelease]}),
  {exists: false},
  'target_commitish alone must not make a historical release related',
);
testCount += 1;

const expectedFileFixture = {
  readFileSync(file) {
    if (file === 'valid-assets.json') return JSON.stringify(expectedAssets);
    if (file === 'invalid-assets.json') return '{invalid json';
    if (file === 'unknown-body.md') return armedUnknownBody;
    throw new Error('ENOENT: ' + file);
  },
};
assert.throws(
  () => readExpectedReleaseIdentityFiles('invalid-assets.json', 'unknown-body.md', expectedFileFixture),
  /Expected assets file is invalid JSON/u,
  'damaged expected-assets JSON must throw instead of degrading to no recovery identity',
);
assert.throws(
  () => readExpectedReleaseIdentityFiles('missing-assets.json', 'unknown-body.md', expectedFileFixture),
  /Expected assets file cannot be read/u,
  'a non-empty missing expected-assets path must throw',
);
assert.throws(
  () => readExpectedReleaseIdentityFiles('valid-assets.json', 'missing-body.md', expectedFileFixture),
  /Expected unknown body file cannot be read/u,
  'a non-empty missing expected-body path must throw',
);
testCount += 1;

// Test Case 7: Do not duplicate publish (terminal read-only outcome-unknown)
const recoveredDraftState = decideSourceReleaseState(stateFixture(inspectedUntagged));
assert.equal(
  recoveredDraftState.publishState,
  SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
  'recovered armed draft must remain PUBLISH_OUTCOME_UNKNOWN to prevent duplicate publish on rerun',
);
assert.equal(recoveredDraftState.createDraft, false);
assert.equal(recoveredDraftState.uploadAssets, false);
assert.equal(recoveredDraftState.armPublish, false);
assert.equal(recoveredDraftState.publish, false);
assert.equal(recoveredDraftState.terminalReadOnly, true);
testCount += 1;

// Test Case 8: Unique published immutable untagged-* binds to the requested version
const publishedUntagged = {
  id: 382668782,
  tag_name: 'untagged-cbcaba0123456789',
  target_commitish: commit,
  name: defaultExpectedTitle,
  body: armedUnknownBody,
  draft: false,
  prerelease: false,
  immutable: true,
  published_at: '2026-09-04T02:00:00Z',
  html_url: 'https://github.com/dushengyi1993/shein-sales-bi/releases/tag/untagged-cbcaba0123456789',
  assets,
};
const inspectedPublishedUntagged = evaluateInspectRelease({
  ...baseInspectParams,
  releases: [publishedUntagged],
});
assert.equal(inspectedPublishedUntagged.exists, true);
assert.equal(inspectedPublishedUntagged.id, 382668782);
assert.equal(inspectedPublishedUntagged.tagName, version, 'unique published untagged tagName must bind to the requested version');
assert.equal(inspectedPublishedUntagged.draft, false);
assert.equal(inspectedPublishedUntagged.immutable, true);
assert.equal(inspectedPublishedUntagged.publishedAt, '2026-09-04T02:00:00Z');
const publishedUntaggedState = decideSourceReleaseState(stateFixture(inspectedPublishedUntagged));
assert.equal(
  publishedUntaggedState.publishState,
  SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED,
  'workflow inspect of unique published untagged must be PUBLISHED_VERIFIED',
);
assert.equal(publishedUntaggedState.publish, false);
assert.equal(publishedUntaggedState.terminalReadOnly, true);
const rawPublishedUntaggedState = decideSourceReleaseState(stateFixture({
  exists: true,
  id: 382668782,
  tagName: publishedUntagged.tag_name,
  title: publishedUntagged.name,
  body: publishedUntagged.body,
  draft: false,
  prerelease: false,
  immutable: true,
  publishedAt: publishedUntagged.published_at,
  assets,
}));
assert.equal(
  rawPublishedUntaggedState.publishState,
  SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED,
  'state machine must accept the raw published untagged tag_name',
);
const armedGateFromPublishedUntagged = decideArmedDraftSourceReleaseState(
  armedState(inspectedPublishedUntagged, {expectedReleaseId: 382668782}),
);
assert.equal(armedGateFromPublishedUntagged.publish, false, 'published untagged must not reopen draft recovery/publish');
assert.equal(armedGateFromPublishedUntagged.mode, 'armed-draft-conflict');
testCount += 1;

assert.throws(
  () => evaluateInspectRelease({...baseInspectParams, releases: [normalExactPublished, publishedUntagged]}),
  /exact release has an ambiguous immutable untagged sibling/u,
  'an exact published release plus published untagged sibling must fail closed',
);
testCount += 1;

assert.throws(
  () => evaluateInspectRelease({
    ...baseInspectParams,
    releases: [publishedUntagged, {...publishedUntagged, id: 382668783, tag_name: 'untagged-otherpublished1'}],
  }),
  /duplicate or ambiguous release drafts/u,
  'duplicate published untagged strong matches must fail closed',
);
testCount += 1;

const publishedUntaggedRejects = [
  ['fuzzy title-only sibling', [
    publishedUntagged,
    {
      ...publishedUntagged,
      id: 800,
      tag_name: 'untagged-fuzzytitleonly01',
      body: 'unrelated body',
      target_commitish: 'e'.repeat(40),
      assets: [],
    },
  ]],
  ['wrong commit', [{...publishedUntagged, target_commitish: 'e'.repeat(40)}]],
  ['body drifted', [{...publishedUntagged, body: armedUnknownBody + ' trailing'}]],
  ['assets drifted', [{...publishedUntagged, assets: [{...assets[0], digest: 'sha256:bad'}, assets[1]]}]],
  ['missing published_at', [{...publishedUntagged, published_at: null}]],
  ['not immutable', [{...publishedUntagged, immutable: false}]],
];
for (const [label, releases] of publishedUntaggedRejects) {
  assert.throws(
    () => evaluateInspectRelease({...baseInspectParams, releases}),
    /does not satisfy exact immutable draft contract|duplicate or ambiguous release drafts/u,
    'published untagged must fail closed: ' + label,
  );
  testCount += 1;
}

const bash = resolveGitBash();
const blocks = [
  ...extractYamlLiteralRuns(ciSource).map(block => ({...block, file: ciPath})),
  ...extractYamlLiteralRuns(releaseSource).map(block => ({...block, file: releasePath})),
];
assert.ok(blocks.length >= 3, 'Expected CI and source-release embedded Bash blocks');
for (const block of blocks) {
  const result = spawnSync(bash, ['-n'], {
    input: block.script,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${block.file}:${block.line} failed bash -n:\n${result.stderr || result.stdout}`);
  testCount += 1;
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  tests: testCount,
  bash,
  bashBlocks: blocks.length,
  ciCompletionSource: 'exact-attempt-jobs',
  publishStates: Object.values(SOURCE_RELEASE_PUBLISH_STATES),
})}\n`);
