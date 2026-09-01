#!/usr/bin/env node
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {inspectSourceReleaseVersionOrder} from '../lib/source_release_version.mjs';

function parseArgs(argv) {
  const args = {version: '', remote: 'origin', cwd: process.cwd(), label: 'unspecified'};
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => {
      const value = String(argv[++i] || '').trim();
      if (!value) throw new Error(`Missing value for ${argv[i - 1]}`);
      return value;
    };
    if (argv[i] === '--version') args.version = next();
    else if (argv[i] === '--remote') args.remote = next();
    else if (argv[i] === '--cwd') args.cwd = path.resolve(next());
    else if (argv[i] === '--label') args.label = next();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.version) throw new Error('--version is required');
  if (!/^[A-Za-z0-9._/-]+$/.test(args.remote)) throw new Error('Remote name is invalid');
  return args;
}

export function inspectRemoteSourceReleaseVersionOrder(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const remote = String(options.remote || 'origin').trim();
  const stdout = execFileSync('git', ['ls-remote', '--tags', '--refs', remote], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return inspectSourceReleaseVersionOrder({
    requestedVersion: options.version,
    remoteRefs: stdout.split(/\r?\n/),
  });
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = inspectRemoteSourceReleaseVersionOrder(args);
    process.stdout.write(`${JSON.stringify({...result, label: args.label})}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      code: String(error?.code || 'SOURCE_RELEASE_VERSION_CHECK_FAILED'),
      error: String(error?.message || error),
    })}\n`);
    process.exitCode = 1;
  }
}
