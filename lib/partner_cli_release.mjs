import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const PARTNER_CLI_RELEASE_SCHEMA_VERSION = 1;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function normalizePartnerCliReleasePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Unsafe partner CLI release path: ${value}`);
  }
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe partner CLI release path: ${value}`);
  }
  return normalized;
}

function releaseDescriptor(value = {}) {
  return {
    schemaVersion: Number(value.schemaVersion || PARTNER_CLI_RELEASE_SCHEMA_VERSION),
    version: String(value.version || '').trim(),
    entrypoint: normalizePartnerCliReleasePath(value.entrypoint),
    bootstrap: normalizePartnerCliReleasePath(value.bootstrap),
    codexSkill: normalizePartnerCliReleasePath(value.codexSkill),
  };
}

function assertUniqueReleaseFiles(files) {
  const seen = new Set();
  for (const file of files) {
    const relativePath = normalizePartnerCliReleasePath(file.path);
    if (seen.has(relativePath)) throw new Error(`Duplicate partner CLI release path: ${relativePath}`);
    seen.add(relativePath);
  }
  return seen;
}

function bundleHashInput(bundle) {
  return {
    schemaVersion: Number(bundle.schemaVersion || PARTNER_CLI_RELEASE_SCHEMA_VERSION),
    version: String(bundle.version || ''),
    entrypoint: normalizePartnerCliReleasePath(bundle.entrypoint),
    bootstrap: normalizePartnerCliReleasePath(bundle.bootstrap),
    codexSkill: normalizePartnerCliReleasePath(bundle.codexSkill),
    files: (Array.isArray(bundle.files) ? bundle.files : []).map(file => ({
      path: normalizePartnerCliReleasePath(file.path),
      size: Number(file.size || 0),
      sha256: String(file.sha256 || '').toLowerCase(),
      dataBase64: String(file.dataBase64 || ''),
    })),
  };
}

export async function buildPartnerCliRelease({sourceRoot, manifestFile = ''} = {}) {
  const root = path.resolve(String(sourceRoot || process.cwd()));
  const packageManifestFile = path.resolve(manifestFile || path.join(root, 'config', 'partner_cli_package.json'));
  const packageManifest = JSON.parse((await fs.readFile(packageManifestFile, 'utf8')).replace(/^\uFEFF/, ''));
  const descriptor = releaseDescriptor({
    ...packageManifest,
    schemaVersion: PARTNER_CLI_RELEASE_SCHEMA_VERSION,
  });
  if (!descriptor.version) throw new Error('Partner CLI package version is missing');

  const relativeFiles = [
    ...(Array.isArray(packageManifest.files) ? packageManifest.files : []),
    normalizePartnerCliReleasePath(path.relative(root, packageManifestFile)),
  ].map(normalizePartnerCliReleasePath);
  const uniqueFiles = [...new Set(relativeFiles)];
  for (const required of [descriptor.entrypoint, descriptor.bootstrap, descriptor.codexSkill]) {
    if (!uniqueFiles.includes(required)) throw new Error(`Partner CLI package is missing required file: ${required}`);
  }

  const files = [];
  for (const relativePath of uniqueFiles) {
    const absolute = path.resolve(root, relativePath);
    const relativeCheck = path.relative(root, absolute);
    if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) throw new Error(`Partner CLI file escapes source root: ${relativePath}`);
    const bytes = await fs.readFile(absolute);
    files.push({
      path: relativePath,
      size: bytes.length,
      sha256: sha256(bytes),
      dataBase64: bytes.toString('base64'),
    });
  }
  assertUniqueReleaseFiles(files);
  const bundleBody = {...descriptor, files};
  const bundleSha256 = sha256(Buffer.from(stableJson(bundleHashInput(bundleBody)), 'utf8'));
  const bundle = {...bundleBody, bundleSha256};
  const manifest = {
    ...descriptor,
    bundleSha256,
    files: files.map(({path: filePath, size, sha256: fileSha256}) => ({path: filePath, size, sha256: fileSha256})),
  };
  return {manifest, bundle};
}

export function validatePartnerCliRelease({manifest, bundle} = {}) {
  if (Number(manifest?.schemaVersion) !== PARTNER_CLI_RELEASE_SCHEMA_VERSION
    || Number(bundle?.schemaVersion) !== PARTNER_CLI_RELEASE_SCHEMA_VERSION) {
    throw new Error('Unsupported partner CLI release schema version');
  }
  const manifestDescriptor = releaseDescriptor(manifest);
  const bundleDescriptor = releaseDescriptor(bundle);
  if (!manifestDescriptor.version || manifestDescriptor.version !== bundleDescriptor.version) throw new Error('Partner CLI release version mismatch');
  for (const key of ['entrypoint', 'bootstrap', 'codexSkill']) {
    if (manifestDescriptor[key] !== bundleDescriptor[key]) throw new Error(`Partner CLI release ${key} mismatch`);
  }
  const manifestFiles = Array.isArray(manifest?.files) ? manifest.files : [];
  const bundleFiles = Array.isArray(bundle?.files) ? bundle.files : [];
  const manifestPaths = assertUniqueReleaseFiles(manifestFiles);
  const bundlePaths = assertUniqueReleaseFiles(bundleFiles);
  if (manifestPaths.size !== bundlePaths.size) throw new Error('Partner CLI release file count mismatch');
  for (const required of [manifestDescriptor.entrypoint, manifestDescriptor.bootstrap, manifestDescriptor.codexSkill]) {
    if (!manifestPaths.has(required)) throw new Error(`Partner CLI release required file missing: ${required}`);
  }

  const manifestByPath = new Map(manifestFiles.map(file => [normalizePartnerCliReleasePath(file.path), file]));
  const decodedFiles = [];
  for (const file of bundleFiles) {
    const relativePath = normalizePartnerCliReleasePath(file.path);
    const expected = manifestByPath.get(relativePath);
    if (!expected) throw new Error(`Partner CLI bundle has undeclared file: ${relativePath}`);
    const encoded = String(file.dataBase64 || '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/\s+/g, '').replace(/=+$/, '')) {
      throw new Error(`Partner CLI bundle has invalid base64: ${relativePath}`);
    }
    const actualSha256 = sha256(bytes);
    const expectedSha256 = String(expected.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256 || actualSha256 !== String(file.sha256 || '').toLowerCase()) {
      throw new Error(`Partner CLI file hash mismatch: ${relativePath}`);
    }
    if (bytes.length !== Number(expected.size) || bytes.length !== Number(file.size)) throw new Error(`Partner CLI file size mismatch: ${relativePath}`);
    decodedFiles.push({path: relativePath, bytes, size: bytes.length, sha256: actualSha256});
  }

  const actualBundleSha256 = sha256(Buffer.from(stableJson(bundleHashInput(bundle)), 'utf8'));
  const expectedBundleSha256 = String(manifest?.bundleSha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedBundleSha256)
    || actualBundleSha256 !== expectedBundleSha256
    || actualBundleSha256 !== String(bundle?.bundleSha256 || '').toLowerCase()) {
    throw new Error('Partner CLI bundle hash mismatch');
  }
  return {
    ok: true,
    ...manifestDescriptor,
    bundleSha256: actualBundleSha256,
    files: decodedFiles,
  };
}
