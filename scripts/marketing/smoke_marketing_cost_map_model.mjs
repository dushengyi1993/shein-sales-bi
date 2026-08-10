#!/usr/bin/env node
import {spawnSync} from 'node:child_process';

const testFile = 'scripts/marketing/test_marketing_cost_map_model.py';
const candidates = process.platform === 'win32'
  ? [{command: 'python', prefix: []}, {command: 'py', prefix: ['-3']}]
  : [{command: 'python3', prefix: []}, {command: 'python', prefix: []}];

let last = null;
for (const candidate of candidates) {
  const result = spawnSync(candidate.command, [...candidate.prefix, testFile], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error?.code === 'ENOENT') {
    last = result;
    continue;
  }
  if (result.status !== 0) {
    process.stderr.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
  process.stdout.write(result.stdout || '');
  process.stdout.write(result.stderr || '');
  console.log(JSON.stringify({ok: true, testFile, python: candidate.command}));
  process.exit(0);
}

console.error(JSON.stringify({
  ok: false,
  testFile,
  reason: 'python_runtime_not_found',
  error: last?.error?.message || '',
}));
process.exit(1);
