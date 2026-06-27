#!/usr/bin/env node
/**
 * Generic SHEIN OpenAPI authorization entrypoint.
 *
 * This is a thin compatibility wrapper around the original HL pilot script,
 * which already supports `--store` and `--port`. Keep the generic filename as
 * the operator-facing command so 19-store onboarding does not look HL-specific.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'shein_openapi_authorize_hl.mjs'), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
