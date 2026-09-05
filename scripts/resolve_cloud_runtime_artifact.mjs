#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCloudRuntimeArtifact, runtimeArtifactLocation} from '../lib/cloud_runtime_path_policy.mjs';
try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const locationOnly = process.argv[2] === '--location';
  const file = process.argv[locationOnly ? 3 : 2];
  if (!file || process.argv.length > (locationOnly ? 4 : 3)) throw new Error('Usage: resolve_cloud_runtime_artifact.mjs [--location] <logical-or-physical-file>');
  const artifact = locationOnly ? runtimeArtifactLocation({root, file}) : await readCloudRuntimeArtifact({root, file});
  process.stdout.write(`${artifact.path}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
