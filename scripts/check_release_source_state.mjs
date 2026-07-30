#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

function git(cwd, args) {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function splitNull(value) {
  return String(value || '').split('\0').filter(Boolean);
}

export function inspectReleaseSourceState(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const expectedCommit = String(options.expectedCommit || '').trim();
  const head = git(cwd, ['rev-parse', 'HEAD']).trim();
  const resolvedExpected = expectedCommit
    ? git(cwd, ['rev-parse', '--verify', `${expectedCommit}^{commit}`]).trim()
    : '';
  const dirtyEntries = git(cwd, ['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
  const indexEntries = splitNull(git(cwd, ['ls-files', '-v', '-z']));
  const hiddenIndexEntries = indexEntries
    .filter(entry => entry.startsWith('S ') || /^[a-z] /.test(entry))
    .map(entry => entry.slice(2));
  const trackedFiles = splitNull(git(cwd, ['ls-files', '-z']));
  const missingTrackedFiles = trackedFiles.filter(file => {
    try {
      fs.lstatSync(path.join(cwd, file));
      return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  });
  const commitMatches = !resolvedExpected || head === resolvedExpected;
  return Object.freeze({
    ok: commitMatches
      && dirtyEntries.length === 0
      && hiddenIndexEntries.length === 0
      && missingTrackedFiles.length === 0,
    cwd,
    head,
    expectedCommit: resolvedExpected,
    commitMatches,
    dirtyEntries,
    hiddenIndexEntries,
    missingTrackedFiles,
    trackedFileCount: trackedFiles.length,
  });
}

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    expectedCommit: process.env.SHEIN_BI_RELEASE_EXPECTED_COMMIT || '',
    recordDeployment: '',
    deploymentStateFile: process.env.SHEIN_BI_DEPLOYED_RELEASE_FILE
      || '/srv/shein-bi/runtime/deployed_release.json',
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--cwd') args.cwd = argv[++i];
    else if (argv[i] === '--expected-commit') args.expectedCommit = argv[++i];
    else if (argv[i] === '--record-deployment') args.recordDeployment = argv[++i];
    else if (argv[i] === '--deployment-state-file') args.deploymentStateFile = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (args.recordDeployment && !args.expectedCommit) args.expectedCommit = args.recordDeployment;
  return args;
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = inspectReleaseSourceState(args);
  if (result.ok && args.recordDeployment) {
    const state = {
      schemaVersion: 'shein-bi-deployed-release/v1',
      tag: String(args.recordDeployment),
      commit: result.head,
      recordedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(args.deploymentStateFile), {recursive: true});
    const temporary = `${args.deploymentStateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {encoding: 'utf8', mode: 0o640});
    fs.renameSync(temporary, args.deploymentStateFile);
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
