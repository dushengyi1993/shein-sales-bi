import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BI_OPS_CLI_VERSION} from '../lib/partner_knowledge_cache.mjs';
import {buildPartnerCliRelease, validatePartnerCliRelease} from '../lib/partner_cli_release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'partner_cli_package.json'), 'utf8'));
if (manifest.version !== BI_OPS_CLI_VERSION) throw new Error('partner package version and CLI version differ');
if (manifest.entrypoint !== 'scripts/bi_ops_cli.mjs') throw new Error('partner package entrypoint is unexpected');
if (manifest.bootstrap !== 'scripts/partner_cli_bootstrap.mjs') throw new Error('partner package bootstrap is unexpected');
if (manifest.codexSkill !== 'codex/skills/shein-bi-ops/SKILL.md') throw new Error('partner package Codex skill is unexpected');
if (!manifest.files.includes('config/store_style_profiles.json')) throw new Error('partner package must include store image-style evidence');
const storeProfiles = JSON.parse(await fs.readFile(path.join(ROOT, 'config', 'store_style_profiles.json'), 'utf8'));
const expectedTitleGroups = {
  title1: ['JSH', 'DL', 'TZZ', 'CX', 'HL', 'TS', 'TZ'],
  title2: ['DX', 'LQ', 'XC', 'MZ', 'NM', 'YJ'],
  title3: ['JY', 'QY', 'XL', 'FY', 'QH', 'ZL'],
};
const configuredTitleGroups = storeProfiles.defaultTitleGroups || {};
const configuredStores = Object.keys(configuredTitleGroups);
if (configuredStores.length !== 19 || new Set(configuredStores).size !== 19) throw new Error('default title groups must cover 19 unique stores');
for (const [titleGroup, stores] of Object.entries(expectedTitleGroups)) {
  for (const store of stores) {
    if (configuredTitleGroups[store] !== titleGroup) throw new Error(`${store} default title group must be ${titleGroup}`);
  }
}
const expectedStyleProfiles = {
  DL: ['简约', '现代', '都市', '白灰'],
  QY: ['简约', '现代', '都市', '白灰'],
  YJ: ['意式'],
  JY: ['意式'],
  DX: ['浅色奢华', '金色'],
  XL: ['浅色奢华', '金色'],
  HL: ['奶油ins风'],
  LQ: ['奶油ins风'],
  TZZ: ['家居性感风'],
  ZL: ['法式', '法式复古'],
  CX: ['法式', '法式复古'],
  TS: ['海洋系', '度假风', '蓝色系'],
  QH: ['海洋系', '度假风', '蓝色系'],
  MZ: ['森系', '自然系'],
  XC: ['森系', '自然系'],
  FY: ['沙漠风', '岩土风', '沙特传统'],
  JSH: ['沙漠风', '岩土风', '沙特传统'],
  NM: ['深色奢华系', '黑金'],
  TZ: ['深色奢华系', '黑金'],
};
const configuredProfiles = storeProfiles.profiles || {};
if (Object.keys(configuredProfiles).length !== 19) throw new Error('store style profiles must cover 19 stores');
for (const [store, styles] of Object.entries(expectedStyleProfiles)) {
  if (JSON.stringify(configuredProfiles[store]) !== JSON.stringify(styles)) {
    throw new Error(`${store} style profile must be ${styles.join(',')}`);
  }
}
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
const packageBuilderText = await fs.readFile(path.join(ROOT, 'scripts/build_partner_bi_ops_cli_package.ps1'), 'utf8');
if (!packageBuilderText.includes('[Security.Cryptography.SHA256]::Create()') || /\bGet-FileHash\b/.test(packageBuilderText)) {
  throw new Error('partner package builder must compute SHA256 without depending on Get-FileHash module autoload');
}
const installerText = await fs.readFile(path.join(ROOT, 'scripts/install_partner_bi_ops_cli.ps1'), 'utf8');
if (!installerText.includes('%~dp0bootstrap.mjs')) {
  throw new Error('partner launcher must resolve bootstrap relative to itself so Unicode install paths remain valid');
}
const cliText = await fs.readFile(path.join(ROOT, 'scripts/bi_ops_cli.mjs'), 'utf8');
if (!cliText.includes("--sku-code') args.skuCodeList.push(...splitListPreserveCase")
  || !cliText.includes("--supplier-sku') args.supplierSkuList.push(...splitListPreserveCase")) {
  throw new Error('partner CLI must preserve case-sensitive SKU and supplier SKU values');
}
for (const requiredModule of [
  'lib/link_ops_product_descriptions.mjs',
  'lib/link_ops_description_material_extract.mjs',
]) {
  if (!manifest.files.includes(requiredModule)) {
    throw new Error(`partner package must include ${requiredModule}`);
  }
  const moduleText = await fs.readFile(path.join(ROOT, requiredModule), 'utf8');
  if (moduleText.includes('\r')) throw new Error(`${requiredModule} must use LF line endings`);
}
if (!cliText.includes("from '../lib/link_ops_product_descriptions.mjs'")
  || !cliText.includes("from '../lib/link_ops_description_material_extract.mjs'")) {
  throw new Error('partner CLI imports of description modules are missing from the packaged CLI');
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
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`packaged CLI did not start: ${result.stderr || result.stdout || `exit=${result.code}`}`);
  }
  const output = JSON.parse(result.stdout);
  if (result.code !== 0 || output.version !== manifest.version) throw new Error(`packaged CLI did not start: ${result.stderr || result.stdout}`);
  const release = await buildPartnerCliRelease({sourceRoot: ROOT});
  const validated = validatePartnerCliRelease(release);
  if (validated.version !== manifest.version) throw new Error('validated release version differs from package');
  if (!validated.files.some(file => file.path === manifest.codexSkill)) throw new Error('validated release omitted Codex skill');

  const installRoot = path.join(temp, 'managed');
  const versionRoot = path.join(installRoot, 'versions', manifest.version);
  for (const relative of manifest.files) {
    const target = path.join(versionRoot, relative);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.copyFile(path.join(ROOT, relative), target);
  }
  const entrypoint = path.join(versionRoot, manifest.entrypoint);
  await fs.mkdir(installRoot, {recursive: true});
  await fs.copyFile(path.join(versionRoot, manifest.bootstrap), path.join(installRoot, 'bootstrap.mjs'));
  await fs.writeFile(path.join(installRoot, 'current.json'), `${JSON.stringify({version: manifest.version, entrypoint})}\n`, 'utf8');
  const boot = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installRoot, 'bootstrap.mjs'), 'version'], {cwd: installRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
  const bootOutput = JSON.parse(boot.stdout);
  if (boot.code !== 0 || bootOutput.version !== manifest.version || bootOutput.managed !== true) throw new Error(`managed bootstrap did not start current CLI: ${boot.stderr || boot.stdout}`);
  console.log(JSON.stringify({ok: true, version: manifest.version, fileCount: manifest.files.length, bundleSha256: validated.bundleSha256, managedBootstrap: true}));
} finally {
  await fs.rm(temp, {recursive: true, force: true});
}
