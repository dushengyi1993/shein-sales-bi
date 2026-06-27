#!/usr/bin/env node
/**
 * Generic SHEIN OpenAPI single-store read-only probe.
 *
 * The historical probe script name contains `hl` because HL was the first
 * pilot. The implementation already accepts `--store`; this wrapper is the
 * stable command for all 19 stores.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'probe_shein_openapi_hl.mjs'), ...process.argv.slice(2)], {
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
