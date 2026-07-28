import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {compareBiOpsCliVersions} from './partner_knowledge_cache.mjs';
import {normalizePartnerCliReleasePath, validatePartnerCliRelease} from './partner_cli_release.mjs';

const UPDATE_LOCK_TIMEOUT_MS = 120_000;
const UPDATE_LOCK_STALE_MS = 10 * 60_000;
const MAX_RELEASE_RESPONSE_BYTES = 24 * 1024 * 1024;

function partnerCliAuthError({expired = false} = {}) {
  const error = new Error(
    expired
      ? 'BI 登录已失效，CLI 尚未开始查数。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”重新登录一次，再重试原命令。'
      : '尚未登录 BI，CLI 尚未开始查数。请先运行“$HOME\\.shein-bi\\cli\\shein-bi-ops.cmd login --username <你的BI账号>”完成登录，再重试原命令。',
  );
  error.code = expired ? 'BI_SESSION_EXPIRED' : 'BI_LOGIN_REQUIRED';
  if (expired) error.status = 401;
  return error;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
    try {
      await fs.rename(temp, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const backup = `${file}.${process.pid}.${Date.now()}.bak`;
      await fs.rename(file, backup);
      try { await fs.rename(temp, file); } catch (replaceError) {
        await fs.rename(backup, file).catch(() => {});
        throw replaceError;
      }
      await fs.rm(backup, {force: true});
    }
    try { await fs.chmod(file, 0o600); } catch {}
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

async function writeFileAtomic(file, bytes, mode = 0o600) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temp, bytes, {mode});
    try {
      await fs.rename(temp, file);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error;
      const backup = `${file}.${process.pid}.${Date.now()}.bak`;
      await fs.rename(file, backup);
      try { await fs.rename(temp, file); } catch (replaceError) {
        await fs.rename(backup, file).catch(() => {});
        throw replaceError;
      }
      await fs.rm(backup, {force: true});
    }
    try { await fs.chmod(file, mode); } catch {}
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

function inside(root, relativePath) {
  const target = path.resolve(root, normalizePartnerCliReleasePath(relativePath));
  const rel = path.relative(path.resolve(root), target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Partner CLI update path escapes install root: ${relativePath}`);
  return target;
}

async function fetchReleaseJson(fetchImpl, url, {cookie = '', headers = {}, timeoutMs = 60_000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: {accept: 'application/json', ...(cookie ? {cookie} : {}), ...headers},
      signal: controller.signal,
    });
    if (response.status === 304) return {response, json: null};
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_RELEASE_RESPONSE_BYTES) throw new Error('Partner CLI release response is too large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RELEASE_RESPONSE_BYTES) throw new Error('Partner CLI release response is too large');
    if (response.status === 401) throw partnerCliAuthError({expired: true});
    let json = {};
    try { json = bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; } catch { throw new Error(`Partner CLI release endpoint returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok || json?.ok === false) {
      const error = new Error(json?.error || `Partner CLI release HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return {response, json};
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error('Partner CLI update request timed out');
      timeout.code = 'PARTNER_CLI_UPDATE_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function findManagedPartnerCliInstallRoot({entryRoot = '', installRoot = ''} = {}) {
  if (installRoot) {
    const explicit = path.resolve(installRoot);
    return (await readJson(path.join(explicit, 'current.json'), null)) ? explicit : '';
  }
  if (process.env.SHEIN_BI_OPS_INSTALL_ROOT) {
    const fromEnv = path.resolve(process.env.SHEIN_BI_OPS_INSTALL_ROOT);
    if (await readJson(path.join(fromEnv, 'current.json'), null)) return fromEnv;
  }
  let cursor = path.resolve(entryRoot || process.cwd());
  for (let depth = 0; depth < 5; depth += 1) {
    if (await readJson(path.join(cursor, 'current.json'), null)) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return '';
}

async function validManagedPointerEntrypoint(managedRoot, pointer = {}) {
  const raw = String(pointer?.entrypoint || '').trim();
  if (!raw) return '';
  const pointerEntrypoint = path.resolve(raw);
  const versionsRoot = path.resolve(managedRoot, 'versions');
  const relative = path.relative(versionsRoot, pointerEntrypoint);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return '';
  const stat = await fs.stat(pointerEntrypoint).catch(() => null);
  return stat?.isFile() ? pointerEntrypoint : '';
}

async function installValidatedRelease({validated, installRoot, codexHome = '', now = new Date()} = {}) {
  const versionsRoot = path.join(installRoot, 'versions');
  const versionRoot = path.join(versionsRoot, validated.version);
  const tempRoot = path.join(versionsRoot, `.${validated.version}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(versionsRoot, {recursive: true});
  await fs.rm(tempRoot, {recursive: true, force: true});
  try {
    for (const file of validated.files) {
      const target = inside(tempRoot, file.path);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.writeFile(target, file.bytes, {mode: 0o600});
    }
    const existing = await fs.stat(versionRoot).catch(() => null);
    if (existing) {
      let validExisting = true;
      for (const file of validated.files) {
        try {
          const bytes = await fs.readFile(inside(versionRoot, file.path));
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) validExisting = false;
        } catch {
          validExisting = false;
        }
      }
      if (!validExisting) await fs.rm(versionRoot, {recursive: true, force: true});
    }
    if (!(await fs.stat(versionRoot).catch(() => null))) await fs.rename(tempRoot, versionRoot);
  } finally {
    await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => {});
  }

  const bootstrapSource = inside(versionRoot, validated.bootstrap);
  await writeFileAtomic(path.join(installRoot, 'bootstrap.mjs'), await fs.readFile(bootstrapSource), 0o700);
  const skillSource = inside(versionRoot, validated.codexSkill);
  const skillRoot = path.resolve(codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const skillTarget = path.join(skillRoot, 'skills', 'shein-bi-ops', 'SKILL.md');
  await writeFileAtomic(skillTarget, await fs.readFile(skillSource), 0o600);

  const entrypoint = inside(versionRoot, validated.entrypoint);
  await writeJsonAtomic(path.join(installRoot, 'current.json'), {
    schemaVersion: 2,
    version: validated.version,
    entrypoint,
    entrypointRelative: validated.entrypoint,
    bundleSha256: validated.bundleSha256,
    installedAt: now.toISOString(),
  });
  return {versionRoot, entrypoint, skillTarget};
}

export async function checkAndInstallPartnerCliUpdate({
  baseUrl,
  cookie,
  currentVersion,
  entryRoot = '',
  installRoot = '',
  codexHome = '',
  fetchImpl = globalThis.fetch,
  force = false,
  checkOnly = false,
  timeoutMs = 60_000,
} = {}) {
  const managedRoot = await findManagedPartnerCliInstallRoot({entryRoot, installRoot});
  if (!managedRoot) return {ok: true, managed: false, updated: false, currentVersion};
  const managedPointer = await readJson(path.join(managedRoot, 'current.json'), {});
  if (compareBiOpsCliVersions(String(managedPointer.version || ''), currentVersion) > 0) {
    const pointerEntrypoint = await validManagedPointerEntrypoint(managedRoot, managedPointer);
    if (pointerEntrypoint) {
      return {
        ok: true,
        managed: true,
        updated: true,
        currentVersion,
        latestVersion: String(managedPointer.version),
        entrypoint: pointerEntrypoint,
        source: 'current-pointer',
      };
    }
  }
  if (!cookie) throw partnerCliAuthError();
  const updateStateFile = path.join(managedRoot, 'update-state.json');
  const priorState = await readJson(updateStateFile, {});
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let manifestResult;
  try {
    manifestResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/manifest`, {
      cookie,
      timeoutMs,
      headers: !force && priorState.etag ? {'if-none-match': String(priorState.etag)} : {},
    });
  } catch (error) {
    if ([404, 501].includes(Number(error?.status || 0))) return {ok: true, managed: true, unsupported: true, updated: false, currentVersion};
    throw error;
  }
  if (manifestResult.response.status === 304) {
    if (compareBiOpsCliVersions(currentVersion, String(priorState.latestVersion || '')) < 0) {
      manifestResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/manifest`, {cookie, timeoutMs});
    } else {
      return {ok: true, managed: true, updated: false, currentVersion, latestVersion: priorState.latestVersion || currentVersion, source: 'etag-304'};
    }
  }
  const manifest = manifestResult.json?.data || manifestResult.json;
  const latestVersion = String(manifest?.version || '').trim();
  if (!latestVersion) throw new Error('云端 CLI 更新清单缺少版本号');
  const etag = manifestResult.response.headers.get('etag') || '';
  await writeJsonAtomic(updateStateFile, {checkedAt: new Date().toISOString(), etag, latestVersion, bundleSha256: manifest.bundleSha256 || ''});
  const comparison = compareBiOpsCliVersions(currentVersion, latestVersion);
  if (comparison > 0) return {ok: true, managed: true, updated: false, currentVersion, latestVersion, source: 'local-newer'};
  if (comparison === 0) return {ok: true, managed: true, updated: false, currentVersion, latestVersion, source: 'current'};
  if (checkOnly) return {ok: true, managed: true, updateAvailable: true, updated: false, currentVersion, latestVersion, manifest};

  const lockFile = path.join(managedRoot, '.update.lock');
  const release = await acquireCrossProcessTicketLock(lockFile, {
    timeoutMs: UPDATE_LOCK_TIMEOUT_MS,
    staleMs: UPDATE_LOCK_STALE_MS,
    heartbeatMs: 30_000,
    timeoutMessage: '另一个 CLI 正在安装更新，请稍后重试',
    timeoutCode: 'PARTNER_CLI_UPDATE_LOCK_TIMEOUT',
  });
  try {
    const currentPointer = await readJson(path.join(managedRoot, 'current.json'), {});
    const pointerVersion = String(currentPointer.version || currentVersion);
    if (compareBiOpsCliVersions(pointerVersion, latestVersion) >= 0) {
      const peerEntrypoint = await validManagedPointerEntrypoint(managedRoot, currentPointer);
      if (peerEntrypoint) {
        const peerAdvanced = compareBiOpsCliVersions(currentVersion, pointerVersion) < 0;
        return {
          ok: true,
          managed: true,
          updated: peerAdvanced,
          currentVersion,
          latestVersion: pointerVersion,
          ...(peerAdvanced ? {entrypoint: peerEntrypoint} : {}),
          source: 'updated-by-peer',
        };
      }
      if (compareBiOpsCliVersions(pointerVersion, latestVersion) > 0) {
        throw new Error('CLI current pointer is newer than the server release but its entrypoint is invalid');
      }
    }
    const bundleResult = await fetchReleaseJson(fetchImpl, `${base}/api/partner-cli/bundle`, {cookie, timeoutMs});
    const bundle = bundleResult.json?.data || bundleResult.json;
    const validated = validatePartnerCliRelease({manifest, bundle});
    if (validated.version !== latestVersion) throw new Error('云端 CLI manifest 与 bundle 版本不一致');
    const installed = await installValidatedRelease({validated, installRoot: managedRoot, codexHome});
    return {
      ok: true,
      managed: true,
      updated: true,
      currentVersion,
      latestVersion,
      bundleSha256: validated.bundleSha256,
      ...installed,
    };
  } finally {
    await release();
  }
}

export async function relaunchPartnerCli({entrypoint, argv = process.argv.slice(2), env = process.env} = {}) {
  if (!entrypoint) throw new Error('Updated CLI entrypoint is missing');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], {
      stdio: 'inherit',
      windowsHide: true,
      env: {...env, SHEIN_BI_OPS_UPDATE_RESTARTED: '1'},
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code: Number.isInteger(code) ? code : 1, signal: signal || ''}));
  });
}
