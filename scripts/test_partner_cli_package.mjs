import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BI_OPS_CLI_VERSION} from '../lib/partner_knowledge_cache.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'partner_cli_package.json'), 'utf8'));
if (manifest.version !== BI_OPS_CLI_VERSION) throw new Error('partner package version and CLI version differ');
if (manifest.entrypoint !== 'scripts/bi_ops_cli.mjs') throw new Error('partner package entrypoint is unexpected');
const forbidden = /(?:\.env|secret|token|credential|cookie|session|\.jsonl)$/i;
for (const relative of manifest.files || []) {
  if (path.isAbsolute(relative) || String(relative).split(/[\\/]+/).includes('..')) throw new Error(`partner package path escapes root: ${relative}`);
  if (forbidden.test(relative)) throw new Error(`partner package contains forbidden path: ${relative}`);
  const stat = await fs.stat(path.join(ROOT, relative));
  if (!stat.isFile()) throw new Error(`partner package file is missing: ${relative}`);
}
for (const script of ['scripts/install_partner_bi_ops_cli.ps1', 'scripts/build_partner_bi_ops_cli_package.ps1']) {
  const bytes = await fs.readFile(path.join(ROOT, script));
  if ([...bytes].some(byte => byte > 127)) throw new Error(`${script} must remain ASCII for Windows PowerShell 5`);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'partner-cli-package-'));
try {
  for (const relative of manifest.files) {
    const target = path.join(temp, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(ROOT, relative), target);
  }
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(temp, manifest.entrypoint), 'version'], {cwd: temp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
  const output = JSON.parse(result.stdout);
  if (result.code !== 0 || output.version !== manifest.version) throw new Error(`packaged CLI did not start: ${result.stderr || result.stdout}`);
  console.log(JSON.stringify({ok: true, version: manifest.version, fileCount: manifest.files.length}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
