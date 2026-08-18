const SOURCE_RELEASE_VERSION_PATTERN = /^(\d{4})\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])\.([1-9]\d*)$/;
const SOURCE_RELEASE_NAMESPACE_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;

function releaseVersionError(message, code = 'SOURCE_RELEASE_VERSION_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseSourceReleaseVersion(value) {
  const version = String(value || '').trim();
  const match = SOURCE_RELEASE_VERSION_PATTERN.exec(version);
  if (!match) {
    throw releaseVersionError(`Invalid source release version: ${version || '<empty>'}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const revision = Number(match[4]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw releaseVersionError(`Invalid calendar date in source release version: ${version}`);
  }
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw releaseVersionError(`Invalid source release revision: ${version}`);
  }
  return Object.freeze({version, year, month, day, revision});
}

export function compareSourceReleaseVersions(left, right) {
  const a = typeof left === 'string' ? parseSourceReleaseVersion(left) : left;
  const b = typeof right === 'string' ? parseSourceReleaseVersion(right) : right;
  for (const field of ['year', 'month', 'day', 'revision']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

export function inspectSourceReleaseVersionOrder({requestedVersion, remoteRefs = []} = {}) {
  const requested = parseSourceReleaseVersion(requestedVersion);
  if (!Array.isArray(remoteRefs)) {
    throw releaseVersionError('Remote tag inventory must be an array', 'SOURCE_RELEASE_TAG_INVENTORY_INVALID');
  }

  const versions = new Map();
  for (const raw of remoteRefs) {
    const line = String(raw || '').trim();
    if (!line) continue;
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+)$/.exec(line);
    if (!match) {
      throw releaseVersionError(`Invalid remote tag inventory row: ${line}`, 'SOURCE_RELEASE_TAG_INVENTORY_INVALID');
    }
    const tag = match[2];
    if (!SOURCE_RELEASE_NAMESPACE_PATTERN.test(tag)) continue;
    const parsed = parseSourceReleaseVersion(tag);
    if (versions.has(parsed.version)) {
      throw releaseVersionError(`Duplicate source release tag in remote inventory: ${parsed.version}`, 'SOURCE_RELEASE_TAG_INVENTORY_INVALID');
    }
    versions.set(parsed.version, parsed);
  }

  const ordered = [...versions.values()].sort(compareSourceReleaseVersions);
  const latest = ordered.at(-1) || null;
  const comparison = latest ? compareSourceReleaseVersions(requested, latest) : 1;
  if (latest && comparison < 0) {
    throw releaseVersionError(
      `Source release version ${requested.version} is behind current latest source tag ${latest.version}`,
      'SOURCE_RELEASE_VERSION_ROLLBACK',
    );
  }
  return Object.freeze({
    ok: true,
    requestedVersion: requested.version,
    latestVersion: latest?.version || '',
    sourceTagCount: ordered.length,
    mode: latest && comparison === 0 ? 'recover-latest' : 'advance',
  });
}
