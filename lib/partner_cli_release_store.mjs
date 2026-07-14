import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildPartnerCliRelease, validatePartnerCliRelease} from './partner_cli_release.mjs';

export const PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION = 1;
export const DEFAULT_PARTNER_CLI_PACKAGE_MAX_BYTES = 16 * 1024 * 1024;

const VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

function deploymentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizeVersion(value) {
  const version = String(value || '').trim();
  if (!VERSION_PATTERN.test(version)) throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI version is invalid');
  return version;
}

export function comparePartnerCliVersions(leftValue, rightValue) {
  const left = normalizeVersion(leftValue).split('.').map(Number);
  const right = normalizeVersion(rightValue).split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

function decodeBase64Strict(value, label) {
  const encoded = String(value || '').replace(/\s+/g, '');
  if (!encoded) throw deploymentError('INVALID_DEPLOYMENT', `${label} is missing`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw deploymentError('INVALID_DEPLOYMENT', `${label} is not valid base64`);
  }
  return bytes;
}

function validatePublishedAt(value) {
  const publishedAt = String(value || '').trim();
  if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI release publishedAt is invalid');
  }
  return new Date(publishedAt).toISOString();
}

function validatePackageBytes({version, fileName, expectedSha256, expectedSize, bytes, maxPackageBytes}) {
  const expectedFileName = `shein-bi-ops-cli-${version}.zip`;
  if (fileName !== expectedFileName) throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI package filename does not match version');
  if (bytes.length < 4 || bytes.length > maxPackageBytes || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI package is not a valid bounded ZIP payload');
  }
  const actualSha256 = sha256(bytes);
  if (!SHA256_PATTERN.test(expectedSha256) || actualSha256 !== expectedSha256) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI package SHA256 mismatch');
  }
  if (Number(expectedSize) !== bytes.length) throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI package size mismatch');
  return {
    bytes,
    fileName,
    size: bytes.length,
    sha256: actualSha256,
    etag: `"pcli-zip-${actualSha256}"`,
  };
}

export function validatePartnerCliDeploymentPayload(payload, {maxPackageBytes = DEFAULT_PARTNER_CLI_PACKAGE_MAX_BYTES} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI deployment payload must be an object');
  }
  if (Number(payload.schemaVersion) !== PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Unsupported partner CLI deployment schema version');
  }

  let validatedRelease;
  try {
    validatedRelease = validatePartnerCliRelease({manifest: payload.manifest, bundle: payload.bundle});
  } catch (error) {
    throw deploymentError('INVALID_DEPLOYMENT', error?.message || String(error));
  }
  const version = normalizeVersion(validatedRelease.version);
  const tagName = String(payload.tagName || '').trim();
  if (tagName !== `partner-cli-v${version}`) {
    throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI release tag does not match version');
  }
  const sourceCommit = String(payload.sourceCommit || '').trim().toLowerCase();
  if (!COMMIT_PATTERN.test(sourceCommit)) throw deploymentError('INVALID_DEPLOYMENT', 'Partner CLI source commit is invalid');
  const publishedAt = validatePublishedAt(payload.publishedAt);

  const packageInput = payload.package || {};
  const packageBytes = decodeBase64Strict(packageInput.dataBase64, 'Partner CLI package');
  const packageFile = validatePackageBytes({
    version,
    fileName: String(packageInput.fileName || '').trim(),
    expectedSha256: String(packageInput.sha256 || '').trim().toLowerCase(),
    expectedSize: packageInput.size,
    bytes: packageBytes,
    maxPackageBytes,
  });

  return {
    schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
    version,
    tagName,
    sourceCommit,
    publishedAt,
    manifest: payload.manifest,
    bundle: payload.bundle,
    bundleSha256: validatedRelease.bundleSha256,
    fileCount: validatedRelease.files.length,
    package: packageFile,
  };
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, {encoding: 'utf8', mode: 0o600});
  await fs.rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function safeReleaseKey(value) {
  const releaseKey = String(value || '').trim();
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d+-[a-f0-9]{64}$/.test(releaseKey)) {
    throw deploymentError('CORRUPT_RELEASE_STORE', 'Partner CLI current release pointer is invalid');
  }
  return releaseKey;
}

function releasePublicStatus(release) {
  return {
    schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
    source: release.source,
    version: release.manifest.version,
    tagName: release.metadata?.tagName || `partner-cli-v${release.manifest.version}`,
    sourceCommit: release.metadata?.sourceCommit || null,
    publishedAt: release.metadata?.publishedAt || null,
    deployedAt: release.metadata?.deployedAt || null,
    bundleSha256: release.manifest.bundleSha256,
    fileCount: release.manifest.files.length,
    package: {
      fileName: release.package.fileName,
      size: release.package.size,
      sha256: release.package.sha256,
    },
  };
}

async function readPackageFiles({packageFile, checksumFile, version, maxPackageBytes}) {
  const [bytes, checksumText] = await Promise.all([
    fs.readFile(packageFile),
    fs.readFile(checksumFile, 'utf8'),
  ]);
  const expectedSha256 = String(checksumText || '').trim().split(/\s+/)[0].toLowerCase();
  return validatePackageBytes({
    version,
    fileName: path.basename(packageFile),
    expectedSha256,
    expectedSize: bytes.length,
    bytes,
    maxPackageBytes,
  });
}

function exclusiveRunner() {
  let tail = Promise.resolve();
  return async work => {
    let release;
    const ticket = new Promise(resolve => { release = resolve; });
    const previous = tail;
    tail = ticket;
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
    }
  };
}

export function createPartnerCliReleaseStore({
  releaseRoot = '',
  fallbackSourceRoot = '',
  fallbackPackageFile = '',
  fallbackChecksumFile = '',
  maxPackageBytes = DEFAULT_PARTNER_CLI_PACKAGE_MAX_BYTES,
  retentionCount = 2,
} = {}) {
  const managedRoot = String(releaseRoot || '').trim() ? path.resolve(releaseRoot) : '';
  const sourceRoot = path.resolve(fallbackSourceRoot || process.cwd());
  let cachedManaged = null;
  let cachedFallback = null;
  const runExclusive = exclusiveRunner();

  async function loadManagedRelease() {
    if (!managedRoot) return null;
    let pointer;
    try {
      pointer = await readJson(path.join(managedRoot, 'current.json'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw deploymentError('CORRUPT_RELEASE_STORE', `Partner CLI current release cannot be read: ${error?.message || String(error)}`);
    }
    const releaseKey = safeReleaseKey(pointer.releaseKey);
    if (cachedManaged?.releaseKey === releaseKey) return cachedManaged.release;

    const releaseDir = path.join(managedRoot, 'releases', releaseKey);
    const [manifest, bundle, metadata, packageBytes, checksumText] = await Promise.all([
      readJson(path.join(releaseDir, 'manifest.json')),
      readJson(path.join(releaseDir, 'bundle.json')),
      readJson(path.join(releaseDir, 'metadata.json')),
      fs.readFile(path.join(releaseDir, 'package.zip')),
      fs.readFile(path.join(releaseDir, 'package.zip.sha256'), 'utf8'),
    ]).catch(error => {
      throw deploymentError('CORRUPT_RELEASE_STORE', `Partner CLI active release is incomplete: ${error?.message || String(error)}`);
    });

    let validatedRelease;
    try {
      validatedRelease = validatePartnerCliRelease({manifest, bundle});
    } catch (error) {
      throw deploymentError('CORRUPT_RELEASE_STORE', error?.message || String(error));
    }
    const version = normalizeVersion(validatedRelease.version);
    const expectedPackageSha256 = String(checksumText || '').trim().split(/\s+/)[0].toLowerCase();
    const packageFile = validatePackageBytes({
      version,
      fileName: String(metadata.packageFileName || ''),
      expectedSha256: expectedPackageSha256,
      expectedSize: metadata.packageSize,
      bytes: packageBytes,
      maxPackageBytes,
    });
    if (metadata.version !== version
      || metadata.bundleSha256 !== validatedRelease.bundleSha256
      || pointer.version !== version
      || pointer.bundleSha256 !== validatedRelease.bundleSha256
      || pointer.packageSha256 !== packageFile.sha256) {
      throw deploymentError('CORRUPT_RELEASE_STORE', 'Partner CLI active release metadata mismatch');
    }
    const release = {source: 'managed', releaseKey, manifest, bundle, metadata, package: packageFile};
    cachedManaged = {releaseKey, release};
    return release;
  }

  async function loadFallbackRelease() {
    if (cachedFallback) return cachedFallback;
    const release = await buildPartnerCliRelease({sourceRoot});
    const version = normalizeVersion(release.manifest.version);
    const packageFile = path.resolve(fallbackPackageFile || path.join(sourceRoot, 'outputs', 'releases', `shein-bi-ops-cli-${version}.zip`));
    const checksumFile = path.resolve(fallbackChecksumFile || `${packageFile}.sha256`);
    const packageData = await readPackageFiles({packageFile, checksumFile, version, maxPackageBytes});
    cachedFallback = {
      source: 'fallback',
      releaseKey: null,
      manifest: release.manifest,
      bundle: release.bundle,
      metadata: null,
      package: packageData,
    };
    return cachedFallback;
  }

  async function getCurrentRelease() {
    const managed = await loadManagedRelease();
    return managed || await loadFallbackRelease();
  }

  async function cleanOldReleases(activeReleaseKey) {
    if (!managedRoot || retentionCount < 1) return;
    const releasesRoot = path.join(managedRoot, 'releases');
    const entries = await fs.readdir(releasesRoot, {withFileTypes: true}).catch(() => []);
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.staging-')) continue;
      try {
        const stat = await fs.stat(path.join(releasesRoot, entry.name));
        candidates.push({name: entry.name, mtimeMs: stat.mtimeMs});
      } catch {}
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const previous = candidates.filter(row => row.name !== activeReleaseKey).slice(0, Math.max(0, retentionCount - 1));
    const keep = new Set([activeReleaseKey, ...previous.map(row => row.name)]);
    for (const candidate of candidates) {
      if (!keep.has(candidate.name)) await fs.rm(path.join(releasesRoot, candidate.name), {recursive: true, force: true});
    }
  }

  async function deploy(payload) {
    if (!managedRoot) throw deploymentError('RELEASE_STORE_DISABLED', 'Partner CLI managed release store is not configured');
    return await runExclusive(async () => {
      const incoming = validatePartnerCliDeploymentPayload(payload, {maxPackageBytes});
      const current = await getCurrentRelease();
      const versionComparison = comparePartnerCliVersions(incoming.version, current.manifest.version);
      const sameRelease = incoming.version === current.manifest.version
        && incoming.bundleSha256 === current.manifest.bundleSha256
        && incoming.package.sha256 === current.package.sha256;
      if (current.source === 'managed' && sameRelease) {
        return {changed: false, active: releasePublicStatus(current)};
      }
      if (versionComparison < 0) throw deploymentError('STALE_VERSION', 'Partner CLI deployment is older than the active version');
      if (current.source === 'managed' && versionComparison === 0 && !sameRelease) {
        throw deploymentError('VERSION_CONFLICT', 'Partner CLI version is immutable and already has different release content');
      }

      const releasesRoot = path.join(managedRoot, 'releases');
      await fs.mkdir(releasesRoot, {recursive: true, mode: 0o700});
      const releaseKey = `${incoming.version}-${incoming.bundleSha256}`;
      const releaseDir = path.join(releasesRoot, releaseKey);
      const stagingDir = path.join(releasesRoot, `.staging-${crypto.randomUUID()}`);
      const deployedAt = new Date().toISOString();
      const metadata = {
        schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
        version: incoming.version,
        tagName: incoming.tagName,
        sourceCommit: incoming.sourceCommit,
        publishedAt: incoming.publishedAt,
        deployedAt,
        bundleSha256: incoming.bundleSha256,
        fileCount: incoming.fileCount,
        packageFileName: incoming.package.fileName,
        packageSize: incoming.package.size,
        packageSha256: incoming.package.sha256,
      };

      await fs.mkdir(stagingDir, {recursive: false, mode: 0o700});
      try {
        await Promise.all([
          fs.writeFile(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(incoming.manifest)}\n`, {encoding: 'utf8', mode: 0o600}),
          fs.writeFile(path.join(stagingDir, 'bundle.json'), `${JSON.stringify(incoming.bundle)}\n`, {encoding: 'utf8', mode: 0o600}),
          fs.writeFile(path.join(stagingDir, 'metadata.json'), `${JSON.stringify(metadata)}\n`, {encoding: 'utf8', mode: 0o600}),
          fs.writeFile(path.join(stagingDir, 'package.zip'), incoming.package.bytes, {mode: 0o600}),
          fs.writeFile(path.join(stagingDir, 'package.zip.sha256'), `${incoming.package.sha256}  ${incoming.package.fileName}\n`, {encoding: 'ascii', mode: 0o600}),
        ]);
        try {
          await fs.rename(stagingDir, releaseDir);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          await fs.rm(stagingDir, {recursive: true, force: true});
        }
      } catch (error) {
        await fs.rm(stagingDir, {recursive: true, force: true});
        throw error;
      }

      const pointerFile = path.join(managedRoot, 'current.json');
      let previousPointer = null;
      try {
        previousPointer = await fs.readFile(pointerFile);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.mkdir(managedRoot, {recursive: true, mode: 0o700});
      await atomicWriteJson(pointerFile, {
        schemaVersion: PARTNER_CLI_DEPLOYMENT_SCHEMA_VERSION,
        releaseKey,
        version: incoming.version,
        bundleSha256: incoming.bundleSha256,
        packageSha256: incoming.package.sha256,
        activatedAt: deployedAt,
      });
      cachedManaged = null;
      try {
        const readback = await loadManagedRelease();
        if (readback.releaseKey !== releaseKey) throw new Error('Partner CLI release pointer readback mismatch');
        await cleanOldReleases(releaseKey);
        return {changed: true, active: releasePublicStatus(readback)};
      } catch (error) {
        cachedManaged = null;
        if (previousPointer) await fs.writeFile(pointerFile, previousPointer, {mode: 0o600});
        else await fs.rm(pointerFile, {force: true});
        throw error;
      }
    });
  }

  async function status() {
    return releasePublicStatus(await getCurrentRelease());
  }

  return {deploy, getCurrentRelease, status};
}
