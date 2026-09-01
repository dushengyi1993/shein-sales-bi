#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {spawnSync} from 'node:child_process';

const MANIFEST_PATH = 'config/partner_cli_package.json';
const INSTALLER_PATH = 'scripts/install_partner_bi_ops_cli.ps1';
const VERSION_PATTERN = /^(\d{4})\.(\d{2})\.(\d{2})\.([1-9]\d*)$/;

class BoundaryError extends Error {}

function fail(message) {
  throw new BoundaryError(message);
}

function parseArgs(argv) {
  const values = {base: []};
  const allowed = new Set(['repo-root', 'base']);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith('--') || !allowed.has(option.slice(2))) {
      fail(`Unexpected argument: ${option}`);
    }
    const name = option.slice(2);
    if (name !== 'base' && Object.hasOwn(values, name)) fail(`Duplicate argument: --${name}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      fail(`Missing value for --${name}`);
    }
    if (name === 'base') values.base.push(argv[index + 1]);
    else values[name] = argv[index + 1];
    index += 1;
  }
  if (!Object.hasOwn(values, 'repo-root') || !String(values['repo-root']).trim()) {
    fail('--repo-root is required and must not be empty');
  }
  if (values.base.length === 0) fail('At least one --base is required');
  if (values.base.some(value => !String(value).trim())) {
    fail('--base values must not be empty');
  }
  return values;
}

function runGit(repoRoot, args, {allowFailure = false} = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) fail(`Unable to run git: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = String(result.stderr || result.stdout || '').trim();
    fail(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function normalizeForComparison(value) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(path.resolve(value));
  } catch {
    resolved = path.resolve(value);
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateRepoRoot(input) {
  const repoRoot = path.resolve(input);
  let stat;
  try {
    stat = fs.statSync(repoRoot);
  } catch (error) {
    fail(`Repository root does not exist: ${repoRoot} (${error.message})`);
  }
  if (!stat.isDirectory()) fail(`Repository root is not a directory: ${repoRoot}`);
  const topLevelResult = runGit(repoRoot, ['rev-parse', '--show-toplevel']);
  const topLevel = String(topLevelResult.stdout).trim();
  if (normalizeForComparison(topLevel) !== normalizeForComparison(repoRoot)) {
    fail(`--repo-root must be the Git repository root; received ${repoRoot}, actual root is ${topLevel}`);
  }
  return repoRoot;
}

function resolveCommit(repoRoot, revision, label) {
  const result = runGit(
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    {allowFailure: true},
  );
  if (result.status !== 0) fail(`${label} cannot be resolved to a commit: ${revision}`);
  const commit = String(result.stdout).trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`${label} did not resolve to a full commit SHA: ${revision}`);
  return commit;
}

function readBlobText(repoRoot, commit, relativePath, label) {
  const result = runGit(repoRoot, ['show', `${commit}:${relativePath}`], {allowFailure: true});
  if (result.status !== 0) fail(`${label} is missing at ${commit}: ${relativePath}`);
  return String(result.stdout).replace(/^\uFEFF/, '');
}

function blobOid(repoRoot, commit, relativePath) {
  const result = runGit(
    repoRoot,
    ['rev-parse', '--verify', '--end-of-options', `${commit}:${relativePath}`],
    {allowFailure: true},
  );
  if (result.status !== 0) return null;
  const oid = String(result.stdout).trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(oid)) fail(`Git returned an invalid object id for ${relativePath} at ${commit}`);
  const type = String(runGit(repoRoot, ['cat-file', '-t', oid]).stdout).trim();
  if (type !== 'blob') fail(`Package boundary entry is not a file at ${commit}: ${relativePath}`);
  return oid;
}

function parseVersion(value, label) {
  if (typeof value !== 'string') fail(`${label} version must be a string`);
  const match = VERSION_PATTERN.exec(value);
  if (!match) fail(`${label} version is invalid: ${JSON.stringify(value)}; expected YYYY.MM.DD.N with N >= 1`);
  const [, yearText, monthText, dayText, revisionText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12) {
    fail(`${label} version is invalid: ${value}; expected a valid calendar date`);
  }
  const leapYear = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > daysInMonth) {
    fail(`${label} version is invalid: ${value}; expected a valid calendar date`);
  }
  return {
    raw: value,
    parts: [BigInt(yearText), BigInt(monthText), BigInt(dayText), BigInt(revisionText)],
  };
}

function validatePackagePath(value, label) {
  if (typeof value !== 'string' || !value) fail(`${label} contains an empty or non-string package path`);
  if (value.includes('\\')) fail(`${label} must use forward slashes: ${value}`);
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail(`${label} contains an absolute path: ${value}`);
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail(`${label} contains an unsafe package path: ${value}`);
  }
  return value;
}

function parseManifest(text, label) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    fail(`${label} manifest is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail(`${label} manifest must be a JSON object`);
  }
  const version = parseVersion(manifest.version, label);
  if (!Array.isArray(manifest.files)) fail(`${label} manifest field "files" must be an array`);
  const files = manifest.files.map((value, index) => validatePackagePath(value, `${label} manifest files[${index}]`));
  if (new Set(files).size !== files.length) fail(`${label} manifest contains duplicate package paths`);
  return {manifest, version, files};
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function compareVersions(left, right) {
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] > right.parts[index]) return 1;
    if (left.parts[index] < right.parts[index]) return -1;
  }
  return 0;
}

function describeBlobChange(before, after) {
  if (before === null) return 'added';
  if (after === null) return 'deleted';
  return 'modified';
}

function assertManifestFilesExist(repoRoot, commit, files, label) {
  for (const relativePath of files) {
    if (!blobOid(repoRoot, commit, relativePath)) {
      fail(`${label} manifest lists a missing packaged file: ${relativePath}`);
    }
  }
}

function checkBoundaryAgainstBase({repoRoot, currentCommit, current, baseInput, baseCommit}) {
  const base = parseManifest(readBlobText(repoRoot, baseCommit, MANIFEST_PATH, 'Base'), 'Base');

  assertManifestFilesExist(repoRoot, baseCommit, base.files, 'Base');
  const changes = [];
  if (stableJson(base.manifest) !== stableJson(current.manifest)) {
    changes.push({kind: 'manifest', path: MANIFEST_PATH, change: 'modified'});
  }

  const packagePaths = [...new Set([...base.files, ...current.files])].sort();
  for (const relativePath of packagePaths) {
    const before = blobOid(repoRoot, baseCommit, relativePath);
    const after = blobOid(repoRoot, currentCommit, relativePath);
    if (before !== after) {
      changes.push({kind: 'package-file', path: relativePath, change: describeBlobChange(before, after)});
    }
  }

  const installerBefore = blobOid(repoRoot, baseCommit, INSTALLER_PATH);
  const installerAfter = blobOid(repoRoot, currentCommit, INSTALLER_PATH);
  if (installerBefore !== installerAfter) {
    changes.push({kind: 'installer', path: INSTALLER_PATH, change: describeBlobChange(installerBefore, installerAfter)});
  }

  const versionComparison = compareVersions(current.version, base.version);
  if (versionComparison < 0) {
    fail(`Partner CLI version rollback is forbidden: base=${base.version.raw} current=${current.version.raw} baseCommit=${baseCommit}`);
  }
  if (versionComparison === 0 && changes.length > 0) {
    const changed = changes.map(item => `${item.kind}:${item.path}:${item.change}`).join(', ');
    fail(`Partner CLI version ${current.version.raw} is unchanged but release content drifted relative to ${baseCommit}: ${changed}`);
  }

  return {
    base: baseInput,
    baseCommit,
    baseVersion: base.version.raw,
    currentVersion: current.version.raw,
    versionChange: versionComparison === 0 ? 'unchanged' : 'increased',
    boundaryChanges: changes,
  };
}

function checkBoundary({repoRoot: repoRootInput, bases: baseInputs}) {
  const repoRoot = validateRepoRoot(repoRootInput);
  const currentCommit = resolveCommit(repoRoot, 'HEAD', 'Current HEAD');
  const current = parseManifest(readBlobText(repoRoot, currentCommit, MANIFEST_PATH, 'Current'), 'Current');
  assertManifestFilesExist(repoRoot, currentCommit, current.files, 'Current');
  if (!blobOid(repoRoot, currentCommit, INSTALLER_PATH)) fail(`Current installer is missing: ${INSTALLER_PATH}`);

  const resolvedBases = [];
  const seenCommits = new Set();
  for (let index = 0; index < baseInputs.length; index += 1) {
    const baseInput = String(baseInputs[index]);
    const baseCommit = resolveCommit(repoRoot, baseInput, `Base ref/commit #${index + 1}`);
    if (seenCommits.has(baseCommit)) continue;
    seenCommits.add(baseCommit);
    resolvedBases.push(checkBoundaryAgainstBase({repoRoot, currentCommit, current, baseInput, baseCommit}));
  }
  if (resolvedBases.length === 0) fail('No unique base commits remain after deduplication');

  const output = {
    ok: true,
    currentCommit,
    currentVersion: current.version.raw,
    baseCount: resolvedBases.length,
    bases: resolvedBases,
  };
  if (resolvedBases.length === 1) Object.assign(output, resolvedBases[0]);
  return output;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const result = checkBoundary({repoRoot: args['repo-root'], bases: args.base});
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Partner CLI version boundary check failed: ${message}\n`);
  process.exitCode = 1;
}
