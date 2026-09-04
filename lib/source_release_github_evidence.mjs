import crypto from 'node:crypto';
import {
  expectedAnnotatedTagMessage,
  sha256Hex,
  verifySourceReleaseAttestationBuffers,
} from './source_release_attestation.mjs';
import {readRegularBoundedFileAsync} from './source_release_attestation.mjs';

export const SOURCE_RELEASE_TRUST_POLICY_SCHEMA = 'shein-bi-source-release-trust-policy/v1';
export const SOURCE_RELEASE_REPOSITORY_ID = 1228612468;
export const SOURCE_RELEASE_REPOSITORY_FULL_NAME = 'dushengyi1993/shein-sales-bi';
export const SOURCE_RELEASE_REQUIRED_CI_JOB_NAMES = Object.freeze([
  'Source checks',
  'Deterministic shard 1/4',
  'Deterministic shard 2/4',
  'Deterministic shard 3/4',
  'Deterministic shard 4/4',
  'Release gate',
  'CI terminal gate',
]);
export const SOURCE_RELEASE_PUBLISH_STATES = Object.freeze({
  DRAFT_READY: 'DRAFT_READY',
  PUBLISH_OUTCOME_UNKNOWN: 'PUBLISH_OUTCOME_UNKNOWN',
  PUBLISHED_VERIFIED: 'PUBLISHED_VERIFIED',
  PUBLISHED_CONFLICT: 'PUBLISHED_CONFLICT',
});
export const SOURCE_RELEASE_PUBLICATION_JOURNAL_SCHEMA = 'shein-bi-source-release-publication/v1';

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('SOURCE_RELEASE_POLICY_INVALID', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw fail('SOURCE_RELEASE_POLICY_INVALID', `${label} keys are not exact`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function isIso(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isUntaggedSourceReleaseTagName(tagName) {
  return typeof tagName === 'string' && /^untagged-[A-Za-z0-9._-]+$/.test(tagName);
}

function validSha(value, length = 40) {
  return new RegExp(`^[0-9a-f]{${length}}$`).test(String(value || ''));
}

export function validateSourceReleaseTrustPolicy(policy) {
  exactKeys(policy, ['schemaVersion', 'repository', 'ci', 'sourceRelease'], 'trust policy');
  exactKeys(policy.repository, ['id', 'fullName', 'defaultBranch'], 'trust policy repository');
  exactKeys(
    policy.ci,
    [
      'workflowPath',
      'workflowApiId',
      'event',
      'branch',
      'requiredRunConclusion',
      'requiredJobNames',
      'allowedJobConclusions',
    ],
    'trust policy CI',
  );
  exactKeys(
    policy.sourceRelease,
    ['workflowPath', 'releaseTitlePrefix', 'assetNames', 'requireImmutableReleases', 'requireOwnerEnforcement'],
    'trust policy source release',
  );
  if (policy.schemaVersion !== SOURCE_RELEASE_TRUST_POLICY_SCHEMA
    || policy.repository.id !== SOURCE_RELEASE_REPOSITORY_ID
    || policy.repository.fullName !== SOURCE_RELEASE_REPOSITORY_FULL_NAME
    || policy.repository.defaultBranch !== 'main'
    || policy.ci.workflowPath !== '.github/workflows/ci.yml'
    || policy.ci.workflowApiId !== 'ci.yml'
    || policy.ci.event !== 'push'
    || policy.ci.branch !== 'main'
    || policy.ci.requiredRunConclusion !== 'success'
    || !Array.isArray(policy.ci.requiredJobNames)
    || stableJson(policy.ci.requiredJobNames) !== stableJson(SOURCE_RELEASE_REQUIRED_CI_JOB_NAMES)
    || !Array.isArray(policy.ci.allowedJobConclusions)
    || stableJson(policy.ci.allowedJobConclusions) !== stableJson(['success'])
    || policy.sourceRelease.workflowPath !== '.github/workflows/source-release.yml'
    || policy.sourceRelease.releaseTitlePrefix !== 'SHEIN BI Ops '
    || stableJson(policy.sourceRelease.assetNames) !== stableJson([
      'release-attestation.json',
      'release-attestation.json.sha256',
    ])
    || policy.sourceRelease.requireImmutableReleases !== true
    || typeof policy.sourceRelease.requireOwnerEnforcement !== 'boolean') {
    throw fail('SOURCE_RELEASE_POLICY_INVALID', 'Tracked source release trust policy is invalid');
  }
  return Object.freeze(policy);
}

export async function readSourceReleaseTrustPolicy(file) {
  let bytes;
  try {
    ({bytes} = await readRegularBoundedFileAsync(file, 64 * 1024, 'source release trust policy'));
  } catch (error) {
    throw fail(
      'SOURCE_RELEASE_POLICY_READ_FAILED',
      `Source release trust policy cannot be read safely: ${error.message}`,
      {causeCode: error?.code},
    );
  }
  let policy;
  try {
    policy = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw fail('SOURCE_RELEASE_POLICY_INVALID', `Source release trust policy JSON is invalid: ${error.message}`);
  }
  return Object.freeze({policy: validateSourceReleaseTrustPolicy(policy), bytes, sha256: sha256Hex(bytes)});
}

function apiUrl(base, value) {
  if (/^https:\/\//.test(String(value || ''))) return String(value);
  return new URL(String(value || '').replace(/^\//, ''), `${String(base).replace(/\/$/, '')}/`).href;
}

export function createGitHubEvidenceClient({
  fetchImpl = globalThis.fetch,
  token = '',
  apiBaseUrl = 'https://api.github.com',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  const request = async (resource, {accept = 'application/vnd.github+json', allow404 = false, bytes = false} = {}) => {
    let response;
    try {
      response = await fetchImpl(apiUrl(apiBaseUrl, resource), {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: accept,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
        },
      });
    } catch (error) {
      throw fail('SOURCE_RELEASE_GITHUB_API_UNKNOWN', `GitHub API read outcome is unknown: ${error.message}`);
    }
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      throw fail('SOURCE_RELEASE_GITHUB_API_FAILED', `GitHub API read failed with HTTP ${response.status}`, {status: response.status});
    }
    if (bytes) return Buffer.from(await response.arrayBuffer());
    try {
      return await response.json();
    } catch (error) {
      throw fail('SOURCE_RELEASE_GITHUB_SCHEMA_INVALID', `GitHub API returned invalid JSON: ${error.message}`);
    }
  };
  return Object.freeze({
    apiBaseUrl,
    json: (resource, options = {}) => request(resource, options),
    bytes: (resource, options = {}) => request(resource, {...options, bytes: true}),
  });
}

async function pagedArray(client, resource, {field = '', maxPages = 20} = {}) {
  const output = [];
  let declaredTotal = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = resource.includes('?') ? '&' : '?';
    const document = await client.json(`${resource}${separator}per_page=100&page=${page}`);
    const rows = field ? document?.[field] : document;
    if (!Array.isArray(rows)) {
      throw fail('SOURCE_RELEASE_GITHUB_SCHEMA_INVALID', `GitHub paginated response is missing ${field || 'an array'}`);
    }
    if (field && Object.hasOwn(document || {}, 'total_count')) {
      if (!Number.isSafeInteger(document.total_count) || document.total_count < 0
        || (declaredTotal !== null && document.total_count !== declaredTotal)) {
        throw fail('SOURCE_RELEASE_GITHUB_SCHEMA_INVALID', 'GitHub pagination total_count is invalid or inconsistent');
      }
      declaredTotal ??= document.total_count;
    }
    output.push(...rows);
    if (rows.length < 100) {
      if (declaredTotal !== null && output.length !== declaredTotal) {
        throw fail(
          'SOURCE_RELEASE_GITHUB_PAGINATION_INCOMPLETE',
          `GitHub pagination returned ${output.length} rows but declared ${declaredTotal}`,
        );
      }
      return output;
    }
  }
  throw fail('SOURCE_RELEASE_GITHUB_PAGINATION_EXCEEDED', `GitHub pagination exceeded ${maxPages} pages`);
}

export function deriveCiAttemptEvidence({run, jobs, policy, expectedCommit, expectedRunId, expectedRunAttempt} = {}) {
  validateSourceReleaseTrustPolicy(policy);
  const repository = policy.repository.fullName;
  const runId = Number(expectedRunId);
  const runAttempt = Number(expectedRunAttempt);
  if (!validSha(expectedCommit)
    || !Number.isSafeInteger(runId) || runId < 1
    || !Number.isSafeInteger(runAttempt) || runAttempt < 1
    || !run || run.id !== runId
    || run.run_attempt !== runAttempt
    || run.head_sha !== expectedCommit
    || run.head_branch !== policy.ci.branch
    || run.event !== policy.ci.event
    || run.path !== policy.ci.workflowPath
    || run.status !== 'completed'
    || run.conclusion !== policy.ci.requiredRunConclusion
    || run.html_url !== `https://github.com/${repository}/actions/runs/${runId}`) {
    throw fail('SOURCE_RELEASE_CI_ATTEMPT_MISMATCH', 'Exact CI run attempt does not match the tracked trust policy');
  }
  if (!Array.isArray(jobs) || jobs.length < 1) {
    throw fail('SOURCE_RELEASE_CI_JOBS_INCOMPLETE', 'Exact CI attempt has no job evidence');
  }
  const allowed = new Set(policy.ci.allowedJobConclusions);
  const requiredNames = new Set(policy.ci.requiredJobNames);
  const ids = new Set();
  const normalized = jobs.map(job => {
    if (!Number.isSafeInteger(job?.id) || job.id < 1 || ids.has(job.id)
      || job.run_id !== runId || job.run_attempt !== runAttempt) {
      throw fail('SOURCE_RELEASE_CI_JOB_ATTEMPT_MISMATCH', 'CI job does not belong to the exact run attempt');
    }
    ids.add(job.id);
    if (typeof job.name !== 'string' || job.name.length === 0) {
      throw fail('SOURCE_RELEASE_CI_JOB_SCHEMA_INVALID', 'CI job display name is missing or invalid');
    }
    if (job.status !== 'completed' || !allowed.has(job.conclusion) || !isIso(job.completed_at)) {
      throw fail(
        job.status === 'completed' && job.conclusion && !allowed.has(job.conclusion)
          ? 'SOURCE_RELEASE_CI_JOB_FAILED'
          : 'SOURCE_RELEASE_CI_JOBS_INCOMPLETE',
        `CI job ${job.name || job.id} is not an allowed completed terminal result`,
      );
    }
    return {
      id: job.id,
      name: job.name,
      runId: job.run_id,
      runAttempt: job.run_attempt,
      status: job.status,
      conclusion: job.conclusion,
      completedAt: job.completed_at,
    };
  }).sort((left, right) => left.id - right.id);
  const jobsByRequiredName = new Map(policy.ci.requiredJobNames.map(name => [name, []]));
  for (const job of normalized) {
    if (requiredNames.has(job.name)) jobsByRequiredName.get(job.name).push(job);
  }
  const missingRequiredJobs = policy.ci.requiredJobNames.filter(name => jobsByRequiredName.get(name).length === 0);
  const duplicateRequiredJobs = policy.ci.requiredJobNames.filter(name => jobsByRequiredName.get(name).length > 1);
  if (missingRequiredJobs.length > 0 || duplicateRequiredJobs.length > 0) {
    throw fail(
      duplicateRequiredJobs.length > 0
        ? 'SOURCE_RELEASE_CI_REQUIRED_JOB_DUPLICATE'
        : 'SOURCE_RELEASE_CI_REQUIRED_JOB_MISSING',
      'Exact CI attempt does not contain each policy-required job display name exactly once',
      {missingRequiredJobs, duplicateRequiredJobs},
    );
  }
  const normalizedRequiredJobs = policy.ci.requiredJobNames.map(name => jobsByRequiredName.get(name)[0]);
  const completedAt = normalized.reduce((latest, job) => (
    !latest || Date.parse(job.completedAt) > Date.parse(latest) ? job.completedAt : latest
  ), '');
  const jobsSha256 = crypto.createHash('sha256').update(`${stableJson({
    jobs: normalized,
    requiredJobs: normalizedRequiredJobs,
  })}\n`).digest('hex');
  return Object.freeze({
    workflow: policy.ci.workflowPath,
    event: policy.ci.event,
    branch: policy.ci.branch,
    headSha: expectedCommit,
    runId,
    runAttempt,
    url: run.html_url,
    completedAt,
    jobCount: normalized.length,
    jobsSha256,
    status: run.status,
    conclusion: run.conclusion,
    jobs: Object.freeze(normalized),
  });
}

export async function fetchExactCiAttemptEvidence({client, policy, commit, runId, runAttempt} = {}) {
  const repository = policy.repository.fullName;
  const run = await client.json(`/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`);
  const jobs = await pagedArray(
    client,
    `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=all`,
    {field: 'jobs'},
  );
  return deriveCiAttemptEvidence({
    run,
    jobs,
    policy,
    expectedCommit: commit,
    expectedRunId: Number(runId),
    expectedRunAttempt: Number(runAttempt),
  });
}

async function latestCiDescriptor({client, policy, commit}) {
  const repository = policy.repository.fullName;
  const rows = await pagedArray(
    client,
    `/repos/${repository}/actions/workflows/${encodeURIComponent(policy.ci.workflowApiId)}/runs?branch=${encodeURIComponent(policy.ci.branch)}&event=${encodeURIComponent(policy.ci.event)}&head_sha=${commit}`,
    {field: 'workflow_runs'},
  );
  const matching = rows.filter(run => run?.head_sha === commit
    && run?.head_branch === policy.ci.branch
    && run?.event === policy.ci.event
    && run?.path === policy.ci.workflowPath
    && Number.isSafeInteger(run?.id) && run.id > 0
    && Number.isSafeInteger(run?.run_attempt) && run.run_attempt > 0);
  matching.sort((left, right) => left.id - right.id || left.run_attempt - right.run_attempt);
  const latest = matching.at(-1);
  if (!latest) throw fail('SOURCE_RELEASE_CI_NOT_FOUND', `No trusted main push CI run exists for ${commit}`);
  return {runId: latest.id, runAttempt: latest.run_attempt};
}

export async function fetchCiBindingEvidence({
  client,
  policy,
  commit,
  boundRunId,
  boundRunAttempt,
  requireLatest = false,
} = {}) {
  const bound = await fetchExactCiAttemptEvidence({
    client, policy, commit, runId: boundRunId, runAttempt: boundRunAttempt,
  });
  const latestDescriptor = await latestCiDescriptor({client, policy, commit});
  const descriptorMatchesBound = bound.runId === latestDescriptor.runId
    && bound.runAttempt === latestDescriptor.runAttempt;
  // Before publication, the selected attempt must still be the latest and its
  // complete job set must independently pass validation. After an immutable
  // release has been published, only the attested bound attempt is authority:
  // a later failed or still-running rerun is diagnostic state and must not
  // revoke the already-signed release. Keep the descriptor for warnings
  // without validating a non-authoritative later attempt.
  const latest = requireLatest && !descriptorMatchesBound
    ? await fetchExactCiAttemptEvidence({
      client,
      policy,
      commit,
      runId: latestDescriptor.runId,
      runAttempt: latestDescriptor.runAttempt,
    })
    : descriptorMatchesBound ? bound : Object.freeze({...latestDescriptor});
  // Read the mutable run endpoint last. A rerun that starts after the list and
  // exact-attempt reads invalidates a pre-publication latest-attempt pin.
  const mutableLatest = await client.json(`/repos/${policy.repository.fullName}/actions/runs/${latest.runId}`);
  if (mutableLatest?.id !== latest.runId
    || mutableLatest?.head_sha !== commit
    || mutableLatest?.head_branch !== policy.ci.branch
    || mutableLatest?.event !== policy.ci.event
    || mutableLatest?.path !== policy.ci.workflowPath
    || !Number.isSafeInteger(mutableLatest?.run_attempt) || mutableLatest.run_attempt < 1) {
    throw fail('SOURCE_RELEASE_CI_LATEST_DRIFT', 'Mutable latest CI endpoint no longer matches the selected run identity');
  }
  const same = descriptorMatchesBound;
  const raced = mutableLatest.run_attempt !== latest.runAttempt;
  if (requireLatest && (!same || raced)) {
    throw fail(
      'SOURCE_RELEASE_CI_LATEST_DRIFT',
      `Latest CI binding changed from run ${bound.runId} attempt ${bound.runAttempt} to run ${latest.runId} attempt ${mutableLatest.run_attempt}`,
    );
  }
  const warnings = [];
  if (!same) warnings.push({
    code: 'BOUND_CI_HAS_NEWER_RERUN',
    boundRunId: bound.runId,
    boundRunAttempt: bound.runAttempt,
    latestRunId: latest.runId,
    latestRunAttempt: latest.runAttempt,
  });
  if (raced) warnings.push({
    code: 'LATEST_CI_ATTEMPT_RACED_READBACK',
    latestRunId: latest.runId,
    selectedRunAttempt: latest.runAttempt,
    mutableRunAttempt: mutableLatest.run_attempt,
  });
  return Object.freeze({
    bound,
    latest,
    warnings: Object.freeze(warnings),
  });
}

export async function fetchLatestCiBindingEvidence({client, policy, commit} = {}) {
  const latest = await latestCiDescriptor({client, policy, commit});
  return fetchCiBindingEvidence({
    client,
    policy,
    commit,
    boundRunId: latest.runId,
    boundRunAttempt: latest.runAttempt,
    requireLatest: true,
  });
}

export function buildPublicationJournal({state, tag, commit, attestationSha256} = {}) {
  if (!Object.values(SOURCE_RELEASE_PUBLISH_STATES).includes(state)
    || !/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/.test(String(tag || ''))
    || !validSha(commit)
    || !validSha(attestationSha256, 64)) {
    throw fail('SOURCE_RELEASE_PUBLICATION_JOURNAL_INVALID', 'Publication journal fields are invalid');
  }
  const document = stableJson({schemaVersion: SOURCE_RELEASE_PUBLICATION_JOURNAL_SCHEMA, state, tag, commit, attestationSha256});
  return `<!-- ${document} -->`;
}

export function parsePublicationJournal(body) {
  const matches = [...String(body || '').matchAll(/<!--\s*(\{[^\r\n]*"schemaVersion":"shein-bi-source-release-publication\/v1"[^\r\n]*\})\s*-->/gu)];
  if (matches.length !== 1) return {ok: false, issue: matches.length === 0 ? 'journal_missing' : 'journal_duplicate'};
  try {
    const value = JSON.parse(matches[0][1]);
    exactKeys(value, ['schemaVersion', 'state', 'tag', 'commit', 'attestationSha256'], 'publication journal');
    if (value.schemaVersion !== SOURCE_RELEASE_PUBLICATION_JOURNAL_SCHEMA
      || !Object.values(SOURCE_RELEASE_PUBLISH_STATES).includes(value.state)
      || !/^\d{4}\.\d{2}\.\d{2}\.[1-9]\d*$/.test(String(value.tag || ''))
      || !validSha(value.commit)
      || !validSha(value.attestationSha256, 64)) {
      return {ok: false, issue: 'journal_fields_invalid'};
    }
    return {ok: true, value};
  } catch {
    return {ok: false, issue: 'journal_json_invalid'};
  }
}

export function replacePublicationJournal(body, journal) {
  const parsed = parsePublicationJournal(body);
  if (!parsed.ok) throw fail('SOURCE_RELEASE_PUBLICATION_JOURNAL_INVALID', `Cannot replace publication journal: ${parsed.issue}`);
  return String(body).replace(/<!--\s*\{[^\r\n]*"schemaVersion":"shein-bi-source-release-publication\/v1"[^\r\n]*\}\s*-->/u, journal);
}

export function inspectExpectedReleaseAssets(actualAssets, expectedAssets) {
  const names = Object.keys(expectedAssets || {}).sort();
  if (stableJson(names) !== stableJson(['release-attestation.json', 'release-attestation.json.sha256'])) {
    throw fail('SOURCE_RELEASE_ASSET_CONTRACT_INVALID', 'Expected release asset contract is invalid');
  }
  if (!Array.isArray(actualAssets)) return {exact: false, missing: names, mismatched: [], unexpected: []};
  const counts = new Map();
  for (const asset of actualAssets) counts.set(asset?.name, (counts.get(asset?.name) || 0) + 1);
  const unexpected = [...counts.keys()].filter(name => !Object.hasOwn(expectedAssets, name));
  const missing = [];
  const mismatched = [];
  for (const name of names) {
    if ((counts.get(name) || 0) !== 1) {
      ((counts.get(name) || 0) === 0 ? missing : mismatched).push(name);
      continue;
    }
    const asset = actualAssets.find(row => row.name === name);
    const expected = expectedAssets[name];
    if (!Number.isSafeInteger(asset?.id) || asset.id < 1
      || asset.state !== 'uploaded'
      || asset.size !== expected.size
      || asset.digest !== expected.digest) mismatched.push(name);
  }
  return {exact: missing.length === 0 && mismatched.length === 0 && unexpected.length === 0, missing, mismatched, unexpected};
}

function conflict(reason, warnings = []) {
  return Object.freeze({
    mode: 'published-conflict',
    publishState: SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_CONFLICT,
    reason,
    createTag: false,
    createDraft: false,
    uploadAssets: false,
    armPublish: false,
    publish: false,
    terminalReadOnly: true,
    warnings: Object.freeze([...warnings]),
  });
}

export function decideSourceReleaseState(state = {}) {
  if (!validSha(state.expectedCommit)) throw fail('SOURCE_RELEASE_STATE_INVALID', 'Expected commit is invalid');
  if (state.observedMain !== state.expectedCommit) throw fail('SOURCE_RELEASE_MAIN_DRIFT', 'origin/main moved from the expected commit');
  if (state.releaseReadOutcome === 'unknown') {
    return Object.freeze({
      mode: 'publish-outcome-unknown',
      publishState: SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
      createTag: false,
      createDraft: false,
      uploadAssets: false,
      armPublish: false,
      publish: false,
      terminalReadOnly: true,
      warnings: Object.freeze([]),
    });
  }
  const tag = state.tag || {exists: false};
  if (tag.exists === true) {
    if (tag.type !== 'tag') return conflict('Existing release tag is lightweight or not annotated');
    if (tag.peeledCommit !== state.expectedCommit) return conflict('Annotated tag peeled commit drifted');
    if (tag.messageMatches !== true) return conflict('Annotated tag message or attestation hash drifted');
  } else if (tag.exists !== false) {
    return conflict('Tag existence state is invalid');
  }
  const release = state.release || {exists: false};
  if (release.exists === false) {
    return Object.freeze(tag.exists
      ? {mode: 'tag-only', publishState: null, createTag: false, createDraft: true, uploadAssets: false, armPublish: false, publish: false, terminalReadOnly: false, warnings: Object.freeze([])}
      : {mode: 'new', publishState: null, createTag: true, createDraft: false, uploadAssets: false, armPublish: false, publish: false, terminalReadOnly: false, warnings: Object.freeze([])});
  }
  if (release.exists !== true || !tag.exists) return conflict('Release exists without the exact annotated tag');
  if (!Number.isSafeInteger(release.id) || release.id < 1
    || release.title !== state.expectedTitle
    || release.prerelease !== false || typeof release.draft !== 'boolean'
    || typeof release.immutable !== 'boolean') return conflict('Release identity or metadata drifted');
  const tagNameMatchesVersion = release.tagName === state.version;
  const tagNameMatchesPublishedUntagged = release.draft === false
    && release.immutable === true
    && isIso(release.publishedAt)
    && isUntaggedSourceReleaseTagName(release.tagName);
  if (!tagNameMatchesVersion && !tagNameMatchesPublishedUntagged) {
    return conflict('Release identity or metadata drifted');
  }
  const journal = parsePublicationJournal(release.body);
  if (!journal.ok
    || journal.value.tag !== state.version
    || journal.value.commit !== state.expectedCommit
    || journal.value.attestationSha256 !== state.attestationSha256) {
    return conflict(`Publication journal mismatch: ${journal.issue || 'identity'}`);
  }
  const assets = inspectExpectedReleaseAssets(release.assets, state.expectedAssets);
  if (release.draft) {
    if (journal.value.state === SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN) {
      return Object.freeze({
        mode: 'publish-outcome-unknown',
        publishState: SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
        createTag: false,
        createDraft: false,
        uploadAssets: false,
        armPublish: false,
        publish: false,
        terminalReadOnly: true,
        warnings: Object.freeze([]),
      });
    }
    if (journal.value.state !== SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY || release.immutable) {
      return conflict('Draft publication state is invalid');
    }
    if (!assets.exact) {
      return Object.freeze({
        mode: 'recover-draft',
        publishState: null,
        createTag: false,
        createDraft: false,
        uploadAssets: true,
        armPublish: false,
        publish: false,
        terminalReadOnly: false,
        assets,
        warnings: Object.freeze([]),
      });
    }
    return Object.freeze({
      mode: 'draft-ready',
      publishState: SOURCE_RELEASE_PUBLISH_STATES.DRAFT_READY,
      createTag: false,
      createDraft: false,
      uploadAssets: false,
      armPublish: true,
      publish: false,
      terminalReadOnly: false,
      warnings: Object.freeze([]),
    });
  }
  if (!assets.exact
    || journal.value.state !== SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN
    || release.immutable !== true
    || !isIso(release.publishedAt)) {
    return conflict('Published release is not exact, immutable, or publication-journal bound');
  }
  return Object.freeze({
    mode: 'published-verified',
    publishState: SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED,
    createTag: false,
    createDraft: false,
    uploadAssets: false,
    armPublish: false,
    publish: false,
    terminalReadOnly: true,
    warnings: Object.freeze([...(state.warnings || [])]),
  });
}

function armedConflict(reason) {
  return Object.freeze({
    mode: 'armed-draft-conflict',
    publishState: SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_CONFLICT,
    reason,
    createTag: false,
    createDraft: false,
    uploadAssets: false,
    armPublish: false,
    publish: false,
    terminalReadOnly: true,
    warnings: Object.freeze([]),
  });
}

// An "armed draft" is a GitHub Release whose body already carries the
// write-ahead PUBLISH_OUTCOME_UNKNOWN journal (the arm PATCH persisted) but
// whose draft flag is still true. decideSourceReleaseState deliberately treats
// an armed draft as terminal publish-outcome-unknown because it cannot
// distinguish a crash between arm and publish from an armed-but-not-yet-
// published draft; that threshold is not lowered here. Immediately before the
// single irreversible draft=false PATCH, this gate re-verifies from a fresh
// readback every immutable/trusted field of the exact release that was armed,
// including the unique publication journal. Any drift, unknown, or
// duplicate/multiple publication state fails closed and only a fully
// consistent armed draft receives {mode:'armed-draft', publish:true}.
export function decideArmedDraftSourceReleaseState(state = {}) {
  if (!validSha(state.expectedCommit)) {
    throw fail('SOURCE_RELEASE_STATE_INVALID', 'Expected commit is invalid');
  }
  if (state.observedMain !== state.expectedCommit) {
    throw fail('SOURCE_RELEASE_MAIN_DRIFT', 'origin/main moved from the expected commit');
  }
  if (!Number.isSafeInteger(state.expectedReleaseId) || state.expectedReleaseId < 1) {
    return armedConflict('Armed release id binding is missing or invalid');
  }
  if (typeof state.expectedArmedBody !== 'string' || state.expectedArmedBody.length < 1) {
    return armedConflict('Armed unknown-outcome body binding is missing or invalid');
  }
  const tag = state.tag || {exists: false};
  if (tag.exists !== true || tag.type !== 'tag'
    || tag.peeledCommit !== state.expectedCommit || tag.messageMatches !== true) {
    return armedConflict('Armed draft is not bound to the exact annotated source-release tag');
  }
  const release = state.release || {exists: false};
  if (release.exists !== true) return armedConflict('Armed draft release readback is missing');
  if (!Number.isSafeInteger(release.id) || release.id < 1 || release.id !== state.expectedReleaseId) {
    return armedConflict('Armed draft release id drifted');
  }
  if (release.tagName !== state.version) return armedConflict('Armed draft tag_name drifted');
  if (release.title !== state.expectedTitle) return armedConflict('Armed draft title drifted');
  if (release.draft !== true) return armedConflict('Armed draft is no longer an unpublished draft');
  if (release.prerelease !== false) return armedConflict('Armed draft prerelease flag drifted');
  if (release.immutable !== false) return armedConflict('Armed draft immutable flag drifted');
  if (release.publishedAt !== null) {
    return armedConflict('Armed draft published_at is not null (unknown publication state)');
  }
  const journal = parsePublicationJournal(release.body);
  if (!journal.ok) return armedConflict(`Armed draft publication journal is ${journal.issue}`);
  if (journal.value.tag !== state.version
    || journal.value.commit !== state.expectedCommit
    || journal.value.attestationSha256 !== state.attestationSha256) {
    return armedConflict('Armed draft publication journal identity drifted');
  }
  if (journal.value.state !== SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN) {
    return armedConflict('Armed draft publication state is not the unique unknown-outcome journal');
  }
  if (release.body !== state.expectedArmedBody) {
    return armedConflict('Armed draft body drifted from the persisted unknown-outcome journal body');
  }
  const assets = inspectExpectedReleaseAssets(release.assets, state.expectedAssets);
  if (!assets.exact) return armedConflict('Armed draft expected assets are not exact');
  return Object.freeze({
    mode: 'armed-draft',
    publishState: null,
    createTag: false,
    createDraft: false,
    uploadAssets: false,
    armPublish: false,
    publish: true,
    terminalReadOnly: false,
    releaseId: release.id,
    warnings: Object.freeze([...(state.warnings || [])]),
  });
}

export async function fetchRepositoryTrustEvidence({client, policy} = {}) {
  validateSourceReleaseTrustPolicy(policy);
  const repository = policy.repository.fullName;
  const metadata = await client.json(`/repos/${repository}`);
  if (metadata?.id !== policy.repository.id
    || metadata?.full_name !== repository
    || metadata?.default_branch !== policy.repository.defaultBranch) {
    throw fail('SOURCE_RELEASE_REPOSITORY_DRIFT', 'GitHub repository identity drifted from tracked policy');
  }
  const immutable = await client.json(`/repos/${repository}/immutable-releases`);
  if ((policy.sourceRelease.requireImmutableReleases && immutable?.enabled !== true)
    || (policy.sourceRelease.requireOwnerEnforcement && immutable?.enforced_by_owner !== true)) {
    throw fail('SOURCE_RELEASE_IMMUTABLE_POLICY_DISABLED', 'GitHub immutable releases policy does not satisfy the tracked trust policy');
  }
  return {id: metadata.id, fullName: metadata.full_name, immutable};
}

async function findExactRelease(client, policy, identity) {
  const releases = await pagedArray(client, `/repos/${policy.repository.fullName}/releases`);
  return selectExactOrUniquePublishedUntaggedRelease(releases, identity);
}

function sourceReleaseAssetsExact(assets, expectedAssets) {
  return inspectExpectedReleaseAssets(assets, expectedAssets).exact;
}

function publicationJournalMatches(body, expectedJournal) {
  const journal = parsePublicationJournal(body);
  return journal.ok
    && journal.value.state === expectedJournal.state
    && journal.value.tag === expectedJournal.tag
    && journal.value.commit === expectedJournal.commit
    && journal.value.attestationSha256 === expectedJournal.attestationSha256;
}

function isExactPublishedUntaggedRelease(release, identity) {
  return Boolean(release)
    && release.draft === false
    && release.prerelease === false
    && release.immutable === true
    && isIso(release.published_at)
    && isUntaggedSourceReleaseTagName(release.tag_name)
    && release.name === identity.expectedTitle
    && release.target_commitish === identity.expectedCommit
    && publicationJournalMatches(release.body, identity.expectedJournal)
    && sourceReleaseAssetsExact(release.assets, identity.expectedAssets);
}

function isRelatedSourceRelease(release, identity) {
  return Boolean(release) && (
    release.name === identity.expectedTitle
    || publicationJournalMatches(release.body, identity.expectedJournal)
    || sourceReleaseAssetsExact(release.assets, identity.expectedAssets)
  );
}

function selectExactOrUniquePublishedUntaggedRelease(releases, identity) {
  const exact = releases.filter(release => release?.tag_name === identity.tag);
  if (exact.length > 1) {
    throw fail('SOURCE_RELEASE_RELEASE_IDENTITY_INVALID', `Expected one GitHub Release for ${identity.tag}; found ${exact.length}`);
  }
  const publishedUntagged = releases.filter(release => isExactPublishedUntaggedRelease(release, identity));
  if (exact.length === 1) {
    if (publishedUntagged.some(release => release !== exact[0])) {
      throw fail(
        'SOURCE_RELEASE_RELEASE_IDENTITY_INVALID',
        `Exact GitHub Release for ${identity.tag} has an ambiguous published untagged sibling`,
      );
    }
    return exact[0];
  }
  const related = releases.filter(release => isRelatedSourceRelease(release, identity));
  if (publishedUntagged.length === 1 && related.length === 1 && related[0] === publishedUntagged[0]) {
    return publishedUntagged[0];
  }
  throw fail('SOURCE_RELEASE_RELEASE_IDENTITY_INVALID', `Expected one GitHub Release for ${identity.tag}; found ${exact.length}`);
}

function expectedAssetsFromBytes(attestationBytes, checksumBytes) {
  return {
    'release-attestation.json': {
      size: attestationBytes.length,
      digest: `sha256:${sha256Hex(attestationBytes)}`,
    },
    'release-attestation.json.sha256': {
      size: checksumBytes.length,
      digest: `sha256:${sha256Hex(checksumBytes)}`,
    },
  };
}

function sameCiAttestation(attested, observed) {
  const fields = ['workflow', 'event', 'branch', 'runId', 'runAttempt', 'url', 'completedAt', 'jobCount', 'jobsSha256'];
  return fields.every(field => attested?.[field] === observed?.[field]);
}

function normalizeTagMessage(value) {
  return `${String(value || '').replace(/\r\n/g, '\n').replace(/\n+$/u, '')}\n`;
}

export async function verifyRemoteSourceReleaseEvidence({
  policy,
  trustPolicySha256,
  tag,
  commit,
  attestationBytes,
  checksumBytes,
  client,
  now = () => new Date(),
} = {}) {
  validateSourceReleaseTrustPolicy(policy);
  const verified = verifySourceReleaseAttestationBuffers({
    attestationBytes,
    checksumBytes,
    expectedRepository: policy.repository.fullName,
    expectedRepositoryId: policy.repository.id,
    expectedTag: tag,
    expectedCommit: commit,
    expectedTrustPolicySha256: trustPolicySha256,
    expectedSourceWorkflowPath: policy.sourceRelease.workflowPath,
  });
  if (verified.attestation.schemaVersion !== 3) {
    throw fail('SOURCE_RELEASE_ATTESTATION_LEGACY', 'Remote deployment verification requires attestation schema v3');
  }
  const repository = await fetchRepositoryTrustEvidence({client, policy});
  const ciEvidence = await fetchCiBindingEvidence({
    client,
    policy,
    commit,
    boundRunId: verified.attestation.ci.runId,
    boundRunAttempt: verified.attestation.ci.runAttempt,
    requireLatest: false,
  });
  if (!sameCiAttestation(verified.attestation.ci, ciEvidence.bound)) {
    throw fail('SOURCE_RELEASE_CI_ATTESTATION_DRIFT', 'Remote exact-attempt jobs no longer match the release attestation');
  }

  const ref = await client.json(`/repos/${policy.repository.fullName}/git/ref/tags/${encodeURIComponent(tag)}`);
  if (ref?.ref !== `refs/tags/${tag}` || ref?.object?.type !== 'tag' || !validSha(ref?.object?.sha)) {
    throw fail('SOURCE_RELEASE_REMOTE_TAG_INVALID', 'Remote source release tag is missing or not annotated');
  }
  const tagObject = await client.json(`/repos/${policy.repository.fullName}/git/tags/${ref.object.sha}`);
  const expectedMessage = expectedAnnotatedTagMessage({
    tag,
    commit,
    ci: verified.attestation.ci,
    attestationSha256: verified.attestationSha256,
  });
  if (tagObject?.sha !== ref.object.sha
    || tagObject?.object?.type !== 'commit'
    || tagObject?.object?.sha !== commit
    || normalizeTagMessage(tagObject?.message) !== normalizeTagMessage(expectedMessage)) {
    throw fail('SOURCE_RELEASE_REMOTE_TAG_DRIFT', 'Remote annotated tag object, commit, or attestation message drifted');
  }

  const expectedAssets = expectedAssetsFromBytes(
    Buffer.isBuffer(attestationBytes) ? attestationBytes : Buffer.from(attestationBytes),
    Buffer.isBuffer(checksumBytes) ? checksumBytes : Buffer.from(checksumBytes),
  );
  const expectedTitle = `${policy.sourceRelease.releaseTitlePrefix}${tag}`;
  const release = await findExactRelease(client, policy, {
    tag,
    expectedTitle,
    expectedCommit: commit,
    expectedAssets,
    expectedJournal: {
      state: SOURCE_RELEASE_PUBLISH_STATES.PUBLISH_OUTCOME_UNKNOWN,
      tag,
      commit,
      attestationSha256: verified.attestationSha256,
    },
  });
  const releaseState = decideSourceReleaseState({
    version: tag,
    expectedCommit: commit,
    observedMain: commit,
    expectedTitle,
    attestationSha256: verified.attestationSha256,
    expectedAssets,
    warnings: ciEvidence.warnings,
    tag: {exists: true, type: 'tag', peeledCommit: commit, messageMatches: true},
    release: {
      exists: true,
      id: release.id,
      tagName: release.tag_name,
      title: release.name,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      immutable: release.immutable,
      publishedAt: release.published_at,
      assets: release.assets,
    },
  });
  if (releaseState.publishState !== SOURCE_RELEASE_PUBLISH_STATES.PUBLISHED_VERIFIED) {
    throw fail('SOURCE_RELEASE_REMOTE_RELEASE_CONFLICT', `Remote GitHub Release is not published verified: ${releaseState.reason || releaseState.mode}`);
  }

  const metadata = inspectExpectedReleaseAssets(release.assets, expectedAssets);
  if (!metadata.exact || release.assets.length !== policy.sourceRelease.assetNames.length) {
    throw fail('SOURCE_RELEASE_REMOTE_ASSET_DRIFT', 'Remote release asset metadata is not exact');
  }
  const localBytes = {
    'release-attestation.json': Buffer.isBuffer(attestationBytes) ? attestationBytes : Buffer.from(attestationBytes),
    'release-attestation.json.sha256': Buffer.isBuffer(checksumBytes) ? checksumBytes : Buffer.from(checksumBytes),
  };
  const assets = [];
  for (const name of policy.sourceRelease.assetNames) {
    const asset = release.assets.find(row => row.name === name);
    const downloaded = await client.bytes(
      `/repos/${policy.repository.fullName}/releases/assets/${asset.id}`,
      {accept: 'application/octet-stream'},
    );
    if (!downloaded.equals(localBytes[name])) {
      throw fail('SOURCE_RELEASE_REMOTE_ASSET_BYTES_DRIFT', `Downloaded GitHub Release asset bytes drifted: ${name}`);
    }
    assets.push(Object.freeze({
      name,
      id: asset.id,
      size: asset.size,
      digest: asset.digest,
      bytesSha256: sha256Hex(downloaded),
    }));
  }
  const verifiedAt = now().toISOString();
  if (!isIso(verifiedAt)) throw fail('SOURCE_RELEASE_CLOCK_INVALID', 'Remote verification clock is invalid');
  return Object.freeze({
    repository,
    tagObject: ref.object.sha,
    releaseId: release.id,
    releaseUrl: release.html_url,
    publishedAt: release.published_at,
    immutable: release.immutable,
    assets: Object.freeze(assets),
    ci: ciEvidence.bound,
    warnings: ciEvidence.warnings,
    verifiedAt,
  });
}
