#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

async function readJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

function findInstallRoot() {
  if (process.env.SHEIN_BI_OPS_INSTALL_ROOT) return path.resolve(process.env.SHEIN_BI_OPS_INSTALL_ROOT);
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(scriptDir).toLowerCase() === 'scripts'
    ? path.resolve(scriptDir, '..', '..', '..')
    : scriptDir;
}

const installRoot = findInstallRoot();
const current = await readJson(path.join(installRoot, 'current.json'));
const rawEntrypoint = String(current.entrypoint || '').trim();
if (!rawEntrypoint) throw new Error('Missing SHEIN BI Ops CLI current entrypoint');
const entrypoint = path.resolve(rawEntrypoint);
const versionsRoot = path.resolve(installRoot, 'versions');
const relative = path.relative(versionsRoot, entrypoint);
if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid SHEIN BI Ops CLI current entrypoint');
const entrypointStat = await fs.stat(entrypoint).catch(() => null);
if (!entrypointStat?.isFile()) throw new Error('SHEIN BI Ops CLI current entrypoint is missing');

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
    env: {...process.env, SHEIN_BI_OPS_INSTALL_ROOT: installRoot},
  });
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({code: Number.isInteger(code) ? code : 1, signal}));
});
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.code;
