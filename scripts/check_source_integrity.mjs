#!/usr/bin/env node
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

function trackedFiles(patterns) {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'git ls-files failed');
  // `git ls-files --cached` also lists tracked paths deleted in the current
  // change.  Validate the resulting tree, not files that are intentionally
  // being removed by this commit.
  return result.stdout.split('\0').filter(file => file && fs.existsSync(file));
}

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.status !== 0) {
    throw new Error([`${command} ${args.join(' ')} failed`, result.stdout, result.stderr].filter(Boolean).join('\n'));
  }
}

const javascriptFiles = trackedFiles(['*.js', '*.mjs']);
const jsonFiles = trackedFiles(['*.json']);
const shellFiles = trackedFiles(['*.sh']);

for (const file of javascriptFiles) {
  run(process.execPath, ['--check', file]);
  if (file.endsWith('.mjs')) {
    const source = fs.readFileSync(file, 'utf8');
    if (/\brequire\s*\(/.test(source)) {
      throw new Error(`${file}: CommonJS module loading is not available in native ESM; use an import instead`);
    }
  }
}

for (const file of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${file}: invalid JSON: ${error.message}`);
  }
}

if (shellFiles.length) {
  const bashProbe = spawnSync('bash', ['--version'], {encoding: 'utf8'});
  if (bashProbe.status === 0) {
    for (const file of shellFiles) run('bash', ['-n', file]);
  } else if (process.env.CI) {
    throw new Error('bash is required in CI to validate tracked shell scripts');
  }
}

console.log(JSON.stringify({
  ok: true,
  javascriptFiles: javascriptFiles.length,
  jsonFiles: jsonFiles.length,
  shellFiles: shellFiles.length,
}, null, 2));
