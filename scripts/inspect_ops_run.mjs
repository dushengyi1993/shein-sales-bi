#!/usr/bin/env node
import path from 'node:path';

import {compactOpsRun, verifyOpsRunManifest} from '../lib/ops_run_bundle.mjs';

function parseArgs(argv) {
  const args = {manifest: ''};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--manifest') args.manifest = path.resolve(String(argv[++i] || ''));
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.manifest) throw new Error('Usage: node scripts/inspect_ops_run.mjs --manifest <manifest.json>');
  return args;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const verification = await verifyOpsRunManifest(args.manifest);
  const compact = compactOpsRun(verification.run || {}, verification);
  console.log(JSON.stringify({
    ...compact,
    ok: verification.ok && compact.ok === true,
    runOk: compact.ok === true,
    verified: verification.ok,
    artifacts: verification.artifacts,
    issues: verification.issues,
  }, null, 2));
  if (!verification.ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ok: false, outcome: 'failed', exitCode: 1, error: String(error?.message || error)}, null, 2));
  process.exitCode = 1;
}
