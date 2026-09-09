import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
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
  title3: ['JY', 'QY', 'XL', 'FY', 'QH', 'ZL', 'LG', 'HY'],
};
const configuredTitleGroups = storeProfiles.defaultTitleGroups || {};
const configuredStores = Object.keys(configuredTitleGroups);
if (configuredStores.length !== 21 || new Set(configuredStores).size !== 21) throw new Error('default title groups must cover 21 unique stores');
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
const queryRetryText = await fs.readFile(path.join(ROOT, 'lib/bi_ops_query_retry.mjs'), 'utf8');
const ownerKnowledgeCacheText = await fs.readFile(path.join(ROOT, 'lib/partner_knowledge_cache.mjs'), 'utf8');
const partnerUpdaterText = await fs.readFile(path.join(ROOT, 'lib/partner_cli_updater.mjs'), 'utf8');
if (!manifest.files.includes('lib/bi_ops_query_retry.mjs')
  || !queryRetryText.includes('fetchWithIdempotentNetworkRetry')
  || !cliText.includes('fetchWithIdempotentNetworkRetry(fetch,')
  || !ownerKnowledgeCacheText.includes('fetchWithIdempotentNetworkRetry(fetchImpl,')
  || !partnerUpdaterText.includes('fetchWithIdempotentNetworkRetry(fetchImpl,')) {
  throw new Error('partner package must apply the shared idempotent network retry to CLI reads, owner knowledge and updater checks');
}
if (!queryRetryText.includes("const IDEMPOTENT_FETCH_METHODS = new Set(['GET', 'HEAD'])")
  || !queryRetryText.includes("code = 'BI_TRANSIENT_NETWORK_RETRY_EXHAUSTED'")) {
  throw new Error('partner package retry policy must remain GET/HEAD-only and report exhausted transient reads');
}
const ownerKnowledgeDistributionText = await fs.readFile(path.join(ROOT, 'lib/owner_knowledge_distribution.mjs'), 'utf8');
if (!ownerKnowledgeDistributionText.includes('safeStructuralToken')
  || !/\.\(\?:ruleKey\|risk\|activation\)\$/.test(ownerKnowledgeDistributionText)) {
  throw new Error('partner package must ship the owner-knowledge ruleKey structural-token guard');
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

// ---------------------------------------------------------------------------
// Windows installer integrity contract (scripts/install_partner_bi_ops_cli.ps1)
// ---------------------------------------------------------------------------
// Runs the real installer with Windows PowerShell 5 against a temporary
// Unicode install path and verifies the strong integrity contract shared with
// lib/partner_cli_updater.mjs and scripts/partner_cli_bootstrap.mjs:
// current.json schema v2 with a valid bundleSha256, a compatible
// .verified.json marker, unique same-directory staging published with
// rename/swap (never file-by-file over the final version directory), a
// working managed bootstrap, and fail-closed behavior for incomplete or
// corrupt installations without damaging an existing valid install.

const POWERSHELL_CMD = 'powershell.exe';
const INSTALLER_SCRIPT = path.join(ROOT, 'scripts', 'install_partner_bi_ops_cli.ps1');

function assertInstallerContract(condition, message) {
  if (!condition) throw new Error(`partner CLI installer contract: ${message}`);
}

function installerShellAvailable() {
  if (process.platform !== 'win32') return false;
  const probe = spawnSync(POWERSHELL_CMD, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {encoding: 'utf8'});
  if (probe.status !== 0) return false;
  return spawnSync(POWERSHELL_CMD, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Command node).Source'], {encoding: 'utf8'}).status === 0;
}

function runInstaller({sourceRoot = ROOT, installRoot, codexHome, env = {}}) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL_CMD, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER_SCRIPT,
      '-SourceRoot', sourceRoot,
      '-InstallRoot', installRoot,
      '-CodexHome', codexHome,
    ], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, ...env}});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

function runManagedBoot(installRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(installRoot, 'bootstrap.mjs'), 'version'], {cwd: installRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({code, stdout, stderr}));
  });
}

async function readInstallerJson(file) {
  return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

async function verifyInstalledInstallation(installRoot, codexHome, release, {label = ''} = {}) {
  const pointer = await readInstallerJson(path.join(installRoot, 'current.json'));
  assertInstallerContract(pointer.schemaVersion === 2, `${label} current.json schemaVersion must be 2`);
  assertInstallerContract(pointer.version === release.manifest.version, `${label} current.json version mismatch`);
  assertInstallerContract(typeof pointer.bundleSha256 === 'string' && /^[a-f0-9]{64}$/.test(pointer.bundleSha256), `${label} current.json must carry a valid bundleSha256`);
  assertInstallerContract(pointer.bundleSha256 === release.manifest.bundleSha256, `${label} current.json bundleSha256 must match the canonical release hash`);
  assertInstallerContract(pointer.entrypointRelative === release.manifest.entrypoint, `${label} current.json entrypointRelative mismatch`);
  const versionRoot = path.join(installRoot, 'versions', pointer.version);
  const entrypointStat = await fs.stat(pointer.entrypoint).catch(() => null);
  assertInstallerContract(Boolean(entrypointStat && entrypointStat.isFile()), `${label} current.json entrypoint must resolve to a regular file inside the version root`);
  const marker = await readInstallerJson(path.join(versionRoot, '.verified.json'));
  assertInstallerContract(marker.schemaVersion === 2, `${label} .verified.json schemaVersion must be 2`);
  assertInstallerContract(marker.version === pointer.version, `${label} .verified.json version must match the pointer`);
  assertInstallerContract(marker.bundleSha256 === pointer.bundleSha256, `${label} .verified.json bundleSha256 must match the pointer`);
  assertInstallerContract(marker.entrypoint === release.manifest.entrypoint, `${label} .verified.json entrypoint must match the manifest`);
  const entries = await fs.readdir(path.join(installRoot, 'versions'));
  assertInstallerContract(entries.length === 1 && entries[0] === pointer.version, `${label} versions must contain exactly one published version with no staging/backup residue: ${entries.join(',')}`);
  const rebuilt = await buildPartnerCliRelease({sourceRoot: versionRoot});
  assertInstallerContract(rebuilt.manifest.bundleSha256 === pointer.bundleSha256, `${label} installed tree must rebuild to the pointer bundle hash`);
  const boot = await runManagedBoot(installRoot);
  const bootOutput = boot.stdout.trim() ? JSON.parse(boot.stdout) : null;
  assertInstallerContract(boot.code === 0 && bootOutput && bootOutput.version === pointer.version && bootOutput.managed === true,
    `${label} managed bootstrap must start the current CLI (exit ${boot.code}): ${boot.stderr.trim() || boot.stdout}`);
  const launcher = await fs.readFile(path.join(installRoot, 'shein-bi-ops.cmd'), 'utf8');
  assertInstallerContract(launcher.includes('%~dp0bootstrap.mjs'), `${label} launcher must resolve the bootstrap relative to itself`);
  const skillStat = await fs.stat(path.join(codexHome, 'skills', 'shein-bi-ops', 'SKILL.md')).catch(() => null);
  assertInstallerContract(Boolean(skillStat && skillStat.isFile()), `${label} Codex skill must be installed`);
  return {pointer, marker, versionRoot};
}

const installerRelease = await buildPartnerCliRelease({sourceRoot: ROOT});
const installerValidated = validatePartnerCliRelease(installerRelease);
if (installerShellAvailable()) {

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pathExists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

async function waitUntil(predicate, timeoutMs = 20_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleepMs(stepMs);
  }
  return false;
}

async function acquireInstallerLock(installRoot, {timeoutMs = 15_000, staleMs = 120_000} = {}) {
  const {acquireCrossProcessTicketLock} = await import(pathToFileURL(path.join(ROOT, 'lib', 'cross_process_ticket_lock.mjs')).href);
  return acquireCrossProcessTicketLock(path.join(installRoot, '.update.lock'), {
    timeoutMs,
    staleMs,
    heartbeatMs: 30_000,
    pollMs: 60,
    timeoutMessage: 'installer contract test lock timeout',
    timeoutCode: 'PARTNER_CLI_TEST_LOCK_TIMEOUT',
  });
}
  const installBase = path.join(os.tmpdir(), `partner-cli-installer-\u5b89\u88c5\u9a8c\u8bc1-${process.pid}-${Date.now().toString(36)}`);
  const installRoot = path.join(installBase, 'cli');
  const codexHome = path.join(installBase, 'codex');
  try {
    // 1) Fresh install into a Unicode path: pointer hash, marker, launcher,
    //    skill and full managed bootstrap startup.
    const fresh = await runInstaller({installRoot, codexHome});
    assertInstallerContract(fresh.code === 0, `fresh install must succeed: ${fresh.stderr || fresh.stdout}`);
    const installed = await verifyInstalledInstallation(installRoot, codexHome, installerRelease, {label: 'fresh'});

    // 2) Reinstall while the published tree is valid: the verified tree is
    //    reused and the versions root keeps exactly one entry (no staging or
    //    backup residue), proving the final version directory is never
    //    overwritten file by file.
    const reuse = runInstaller({installRoot, codexHome});
    // The reinstall holds the shared .update.lock from wrapper acquisition
    // until its internal install exits; a competing acquirer must be excluded
    // for the whole run and may never interleave staging/backup or pointer
    // changes.
    const reuseTicketSeen = await waitUntil(async () => {
      const tickets = path.join(installRoot, '.update.lock.tickets');
      if (!(await pathExists(tickets))) return false;
      return (await fs.readdir(tickets)).some(name => name.endsWith('.json'));
    }, 20_000);
    assertInstallerContract(reuseTicketSeen, 'reuse installer must reach the shared update lock');
    const reuseRunning = await Promise.race([reuse.then(() => false), sleepMs(200).then(() => true)]);
    if (reuseRunning) {
      let reuseExcluded = false;
      try {
        const competing = await acquireInstallerLock(installRoot, {timeoutMs: 600, staleMs: 120_000});
        await competing();
      } catch (error) {
        reuseExcluded = /timed out|timeout/i.test(String(error.message));
      }
      if (!reuseExcluded) {
        const reuseDone = await Promise.race([reuse.then(() => true), sleepMs(0).then(() => false)]);
        assertInstallerContract(reuseDone,
          'a second actor acquired the update lock while the installer was still running');
      }
    }
    const reuseResult = await reuse;
    assertInstallerContract(reuseResult.code === 0, `reuse install must succeed: ${reuseResult.stderr || reuseResult.stdout}`);
    await verifyInstalledInstallation(installRoot, codexHome, installerRelease, {label: 'reuse'});

    // 3) Corrupt the published tree: the bootstrap must fail closed without
    //    touching current.json, and a reinstall must repair the tree via the
    //    rename/swap path.
    const cliTarget = path.join(installed.versionRoot, installerValidated.entrypoint);
    const pointerBeforeCorrupt = await fs.readFile(path.join(installRoot, 'current.json'));
    await fs.writeFile(cliTarget, 'BROKEN CORRUPTED CONTENT', 'ascii');
    const corruptBoot = await runManagedBoot(installRoot);
    assertInstallerContract(corruptBoot.code !== 0 && corruptBoot.stdout.trim() === '', 'corrupt install must fail closed without stdout');
    assertInstallerContract(pointerBeforeCorrupt.equals(await fs.readFile(path.join(installRoot, 'current.json'))), 'fail-closed bootstrap must not rewrite current.json');
    const repair = await runInstaller({installRoot, codexHome});
    assertInstallerContract(repair.code === 0, `repair install must succeed: ${repair.stderr || repair.stdout}`);
    await verifyInstalledInstallation(installRoot, codexHome, installerRelease, {label: 'repair'});

    // 4) Unverified crash residue (staging .tmp / backup .bak) must never be
    //    promoted, must not disturb a valid install, and must be collected on
    //    the next successful install.
    const versionsRoot = path.join(installRoot, 'versions');
    const garbage1 = path.join(versionsRoot, `.${installerValidated.version}.9999999999999999.garbage.tmp`);
    const garbage2 = path.join(versionsRoot, `.${installerValidated.version}.8888888888888888.garbage.bak`);
    await fs.mkdir(path.join(garbage1, 'config'), {recursive: true});
    await fs.mkdir(garbage2, {recursive: true});
    await fs.writeFile(path.join(garbage1, 'config', 'partner_cli_package.json'), '{}', 'utf8');
    await fs.writeFile(path.join(garbage2, 'whatever.txt'), 'x', 'utf8');
    const residueBoot = await runManagedBoot(installRoot);
    assertInstallerContract(residueBoot.code === 0, 'valid install must keep booting with unverified residue present');
    const gcRun = await runInstaller({installRoot, codexHome});
    assertInstallerContract(gcRun.code === 0, `GC reinstall must succeed: ${gcRun.stderr || gcRun.stdout}`);
    await verifyInstalledInstallation(installRoot, codexHome, installerRelease, {label: 'gc'});

    // 5) A broken source tree must fail closed before touching the install:
    //    current.json and versions stay byte-identical and the previous valid
    //    install keeps booting.
    const brokenRoot = path.join(installBase, 'broken-source');
    await fs.mkdir(path.join(brokenRoot, 'config'), {recursive: true});
    await fs.copyFile(path.join(ROOT, 'config', 'partner_cli_package.json'), path.join(brokenRoot, 'config', 'partner_cli_package.json'));
    const versionsBeforeBroken = JSON.stringify(await fs.readdir(versionsRoot));
    const pointerBeforeBroken = await fs.readFile(path.join(installRoot, 'current.json'));
    const broken = await runInstaller({sourceRoot: brokenRoot, installRoot, codexHome});
    assertInstallerContract(broken.code !== 0, 'installer must fail closed for a broken source tree');
    assertInstallerContract(pointerBeforeBroken.equals(await fs.readFile(path.join(installRoot, 'current.json'))), 'failed install must not rewrite current.json');
    assertInstallerContract(versionsBeforeBroken === JSON.stringify(await fs.readdir(versionsRoot)), 'failed install must not touch the versions root');
    const finalBoot = await runManagedBoot(installRoot);
    assertInstallerContract(finalBoot.code === 0, 'previous valid install must keep booting after a failed install');

    // 6) Upgrading must never damage a previously published version. This run
    //    also injects a terminating command-invocation error into the
    //    post-pointer smoke: the pointer must still move, the installer must
    //    exit zero, and no staging/backup residue may remain.
    const previousVersion = '2026.08.16.5';
    const previousRoot = path.join(versionsRoot, previousVersion);
    await fs.rename(installed.versionRoot, previousRoot);
    const previousPointer = {
      schemaVersion: 2,
      version: previousVersion,
      entrypoint: path.join(previousRoot, installerValidated.entrypoint),
      entrypointRelative: installerValidated.entrypoint,
      bundleSha256: installerValidated.bundleSha256,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(installRoot, 'current.json'), JSON.stringify(previousPointer, null, 2) + '\n', 'utf8');
    const missingSmokeNode = path.join(installBase, `missing-post-pointer-node-${process.pid}.exe`);
    assertInstallerContract(!(await pathExists(missingSmokeNode)), 'post-pointer smoke fault target must not exist');
    const upgrade = await runInstaller({
      installRoot,
      codexHome,
      env: {SHEIN_BI_OPS_TEST_POST_POINTER_SMOKE_NODE: missingSmokeNode},
    });
    assertInstallerContract(upgrade.code === 0,
      `post-pointer smoke invocation failure must not fail the install: ${upgrade.stderr || upgrade.stdout}`);
    assertInstallerContract((upgrade.stdout + upgrade.stderr).includes('could not start (non-fatal)'),
      'post-pointer smoke invocation failure must be observed as a non-fatal warning');
    const upgradedPointer = await readInstallerJson(path.join(installRoot, 'current.json'));
    assertInstallerContract(upgradedPointer.version === installerValidated.version, 'upgrade pointer must move to the new version');
    const versionsAfterUpgrade = await fs.readdir(versionsRoot);
    assertInstallerContract(versionsAfterUpgrade.includes(previousVersion) && versionsAfterUpgrade.includes(installerValidated.version),
      'upgrade must preserve the previous version directory: ' + versionsAfterUpgrade.join(','));
    assertInstallerContract(!versionsAfterUpgrade.some(name => name.endsWith('.tmp') || name.endsWith('.bak')),
      'successful post-pointer smoke fault must leave no staging/backup residue: ' + versionsAfterUpgrade.join(','));
    assertInstallerContract((await fs.stat(previousRoot)).isDirectory(), 'previous version directory must remain readable');
    const upgradeBoot = await runManagedBoot(installRoot);
    const upgradeBootOutput = upgradeBoot.stdout.trim() ? JSON.parse(upgradeBoot.stdout) : null;
    assertInstallerContract(upgradeBoot.code === 0 && upgradeBootOutput && upgradeBootOutput.version === installerValidated.version,
      'managed bootstrap must start the upgraded CLI after the pointer move');

    // 7) Shared-lock serialization: while an external actor (the online
    //    updater or another installer) holds InstallRoot/.update.lock, every
    //    installer must block without creating staging or moving the pointer;
    //    after release they serialize and converge on one clean install.
    const lockRoot = path.join(installBase, 'lock-cli');
    const lockCodex = path.join(installBase, 'lock-codex');
    const lockRelease = await acquireInstallerLock(lockRoot, {timeoutMs: 30_000, staleMs: 120_000});
    const waiterA = runInstaller({installRoot: lockRoot, codexHome: lockCodex});
    const waiterB = runInstaller({installRoot: lockRoot, codexHome: lockCodex});
    const bothBlocked = await Promise.race([
      Promise.all([waiterA, waiterB]).then(() => false),
      sleepMs(1200).then(() => true),
    ]);
    assertInstallerContract(bothBlocked, 'installers must block while the shared update lock is held');
    const lockVersions = path.join(lockRoot, 'versions');
    assertInstallerContract(!(await pathExists(lockVersions))
      || (await fs.readdir(lockVersions)).every(name => name.startsWith('.')),
      'blocked installers must not create staging or publish a version while the lock is held');
    assertInstallerContract(!(await pathExists(path.join(lockRoot, 'current.json'))),
      'blocked installers must not move the pointer while the lock is held');
    await lockRelease();
    const [waiterAResult, waiterBResult] = await Promise.all([waiterA, waiterB]);
    assertInstallerContract(waiterAResult.code === 0, `serialized installer A must succeed: ${waiterAResult.stderr}`);
    assertInstallerContract(waiterBResult.code === 0, `serialized installer B must succeed: ${waiterBResult.stderr}`);
    await verifyInstalledInstallation(lockRoot, lockCodex, installerRelease, {label: 'lock-serialized'});

    // 9) Pointer-order guard: an unrunnable staged entrypoint must fail the
    //    install BEFORE the version tree is swapped or current.json moves, so
    //    the previous pointer and the previous valid install stay untouched.
    const gateRoot = path.join(installBase, 'gate-source');
    await fs.mkdir(path.join(gateRoot, 'config'), {recursive: true});
    await fs.mkdir(path.join(gateRoot, 'scripts'), {recursive: true});
    for (const fileEntry of installerRelease.manifest.files) {
      const relative = fileEntry.path;
      if (relative === installerValidated.entrypoint) continue;
      const target = path.join(gateRoot, relative);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.copyFile(path.join(ROOT, relative), target);
    }
    await fs.writeFile(path.join(gateRoot, installerValidated.entrypoint), '', 'utf8');
    const gatePointerBefore = await fs.readFile(path.join(installRoot, 'current.json'));
    const gateVersionsBefore = JSON.stringify(await fs.readdir(versionsRoot));
    const gateRun = await runInstaller({sourceRoot: gateRoot, installRoot, codexHome});
    assertInstallerContract(gateRun.code !== 0, 'installer must fail closed when the staged entrypoint is not runnable');
    assertInstallerContract(gatePointerBefore.equals(await fs.readFile(path.join(installRoot, 'current.json'))),
      'gate failure must leave current.json untouched');
    assertInstallerContract(gateVersionsBefore === JSON.stringify(await fs.readdir(versionsRoot)),
      'gate failure must leave the versions root untouched');
    const gateBoot = await runManagedBoot(installRoot);
    assertInstallerContract(gateBoot.code === 0, 'previous valid install must keep booting after a gate failure');
    const installerText = await fs.readFile(INSTALLER_SCRIPT, 'utf8');
    const gateMarker = 'Runnability gate BEFORE anything is published';
    const pointerMarker = "Write-PartnerJsonFile -Path (Join-Path $InstallRoot 'current.json')";
    const smokeMarker = 'Post-pointer smoke is informational only';
    assertInstallerContract(installerText.includes(gateMarker) && installerText.includes(pointerMarker) && installerText.includes(smokeMarker),
      'installer must contain the pre-publish runnability gate, the pointer write, and the non-failing post-pointer smoke');
    assertInstallerContract(installerText.indexOf(gateMarker) < installerText.indexOf(pointerMarker),
      'installer runnability gate must appear before the pointer write');
    const afterPointer = installerText.slice(installerText.indexOf(pointerMarker));
    assertInstallerContract(!/\bthrow\b/.test(afterPointer),
      'no step after the pointer write may fail the install');
    console.log(JSON.stringify({installerIntegrity: true, unicodePath: installRoot, bundleSha256: installerValidated.bundleSha256}));
  } finally {
    await fs.rm(installBase, {recursive: true, force: true});
  }
} else {
  console.log(JSON.stringify({installerIntegrity: 'skipped', reason: 'Windows PowerShell 5 and node are not available on this host'}));
}
