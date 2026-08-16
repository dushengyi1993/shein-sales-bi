import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acquireCrossProcessTicketLock} from './cross_process_ticket_lock.mjs';
import {validateOwnerKnowledgeDistribution} from './owner_knowledge_distribution.mjs';

export const BI_OPS_CLI_VERSION = '2026.08.16.5';
export const DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR = path.join(os.homedir(), '.shein-bi', 'owner-knowledge');

const CACHE_SCHEMA_VERSION = 2;
const CACHE_LOCK_FILE = '.sync.lock';
const CACHE_LOCK_TIMEOUT_MS = 60_000;
const CACHE_LOCK_STALE_MS = 5 * 60_000;

function versionParts(value) {
  return String(value || '').split(/[^0-9]+/).filter(Boolean).map(Number);
}

export function compareBiOpsCliVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
    await fs.rename(temp, file);
    try { await fs.chmod(file, 0o600); } catch {}
  } finally {
    await fs.rm(temp, {force: true}).catch(() => {});
  }
}

async function acquireCacheLock(root, {
  timeoutMs = CACHE_LOCK_TIMEOUT_MS,
  staleMs = CACHE_LOCK_STALE_MS,
  heartbeatMs = Math.max(25, Math.min(30_000, Math.floor(staleMs / 3))),
} = {}) {
  await fs.mkdir(root, {recursive: true});
  const lockFile = path.join(root, CACHE_LOCK_FILE);
  return await acquireCrossProcessTicketLock(lockFile, {
    timeoutMs,
    staleMs,
    heartbeatMs,
    pollMs: Math.max(25, Math.min(100, Math.floor(staleMs / 4))),
    timeoutMessage: '负责人规则本地缓存正被另一个 CLI 更新，请稍后重试',
    timeoutCode: 'OWNER_KNOWLEDGE_CACHE_LOCK_TIMEOUT',
  });
}

function responseJson(response, text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {raw: text}; }
}

async function fetchJson(fetchImpl, url, options = {}, timeoutMs = 60_000) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener?.('abort', abortFromCaller, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('owner knowledge request timeout')), Math.max(1_000, timeoutMs));
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {...options, signal: controller.signal});
    if (response.status === 304) return {response, json: null};
    const text = await response.text();
    const json = responseJson(response, text);
    if (!response.ok || json?.ok === false) {
      const error = new Error(json?.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.response = json;
      throw error;
    }
    return {response, json};
  } catch (error) {
    if (controller.signal.aborted && error?.name === 'AbortError') {
      const timeoutError = new Error('负责人规则服务请求超时');
      timeoutError.code = 'OWNER_KNOWLEDGE_FETCH_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', abortFromCaller);
  }
}

function normalizeApiBundle(data) {
  return {
    schemaVersion: Number(data?.schemaVersion || 1),
    authorityId: String(data?.authorityId || ''),
    fingerprint: String(data?.fingerprint || ''),
    publishedAt: data?.publishedAt ? String(data.publishedAt) : null,
    ruleCount: Number(data?.ruleCount || 0),
    rules: Array.isArray(data?.rules) ? data.rules : [],
  };
}

function manifestForValidation(data) {
  return {
    schemaVersion: Number(data?.schemaVersion || 1),
    authorityId: String(data?.authorityId || ''),
    fingerprint: String(data?.fingerprint || ''),
    publishedAt: data?.publishedAt ? String(data.publishedAt) : null,
    ruleCount: Number(data?.ruleCount || 0),
    bundlePath: String(data?.bundlePath || ''),
    bundleSha256: String(data?.bundleSha256 || ''),
  };
}

function generationId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('负责人规则 bundleSha256 无效');
  return id;
}

function generationBundleFile(root, generation) {
  return path.join(root, 'generations', generationId(generation), 'bundle.json');
}

async function loadValidatedCache(root, cached) {
  if (!cached?.data?.fingerprint || !cached?.data?.bundleSha256) return null;
  const generation = String(cached.generation || cached.data.bundleSha256 || '').trim().toLowerCase();
  let bundleFile;
  try { bundleFile = generationBundleFile(root, generation); } catch { return null; }
  let bundle = await readJson(bundleFile, null);
  // Read-only compatibility for a cache written by the first package revision.
  if (!bundle) bundle = await readJson(path.join(root, 'bundle.json'), null);
  if (!bundle) return null;
  try {
    validateOwnerKnowledgeDistribution({manifest: manifestForValidation(cached.data), bundle});
  } catch {
    return null;
  }
  return {cached, data: cached.data, bundle, generation, bundleFile};
}

function assertManifestNotOlder(incoming, cachedData) {
  const incomingRevision = Number(incoming?.distributionRevision || 0);
  const cachedRevision = Number(cachedData?.distributionRevision || 0);
  if (incomingRevision > 0 && cachedRevision > 0) {
    if (incomingRevision < cachedRevision) throw new Error('负责人规则服务返回了旧于本地缓存的版本，已拒绝回滚');
    if (incomingRevision === cachedRevision
      && (String(incoming?.sourceCommit || '') !== String(cachedData?.sourceCommit || '')
        || String(incoming?.bundleSha256 || '') !== String(cachedData?.bundleSha256 || ''))) {
      throw new Error('负责人规则服务在同一版本号返回了不同内容，已拒绝覆盖');
    }
    return;
  }
  const incomingAt = Date.parse(String(incoming?.publishedAt || ''));
  const cachedAt = Date.parse(String(cachedData?.publishedAt || ''));
  if (Number.isFinite(incomingAt) && Number.isFinite(cachedAt) && incomingAt < cachedAt
    && String(incoming?.fingerprint || '') !== String(cachedData?.fingerprint || '')) {
    throw new Error('负责人规则服务返回了旧于本地缓存的发布时间，已拒绝回滚');
  }
}

function checkCliVersion(data, cliVersion) {
  const minimum = String(data?.cli?.minimumVersion || '');
  const recommended = String(data?.cli?.recommendedVersion || minimum || '');
  if (minimum && compareBiOpsCliVersions(cliVersion, minimum) < 0) {
    const error = new Error(`当前 CLI ${cliVersion} 低于最低版本 ${minimum}，请先更新 CLI`);
    error.code = 'BI_OPS_CLI_UPDATE_REQUIRED';
    throw error;
  }
  return recommended;
}

async function ensurePartnerKnowledgeCurrentLocked({baseUrl, cookie, root, fetchImpl, cliVersion, strict, fetchTimeoutMs}) {
  const manifestFile = path.join(root, 'manifest.json');
  let cached = await readJson(manifestFile, {});
  let validatedCache = await loadValidatedCache(root, cached);
  const commonHeaders = {
    accept: 'application/json',
    'user-agent': `shein-bi-ops-cli/${cliVersion}`,
    ...(cookie ? {cookie} : {}),
  };
  try {
    let manifestResult = await fetchJson(fetchImpl, `${String(baseUrl || '').replace(/\/+$/, '')}/api/owner-knowledge/manifest`, {
      headers: {...commonHeaders, ...(cached?.etag ? {'if-none-match': String(cached.etag)} : {})},
    }, fetchTimeoutMs);
    if (manifestResult.response.status === 304 && !validatedCache) {
      manifestResult = await fetchJson(fetchImpl, `${String(baseUrl || '').replace(/\/+$/, '')}/api/owner-knowledge/manifest`, {headers: commonHeaders}, fetchTimeoutMs);
    }
    if (manifestResult.response.status === 304) {
      if (!validatedCache) throw new Error('owner knowledge server returned 304 but local cache is incomplete');
      checkCliVersion(validatedCache.data, cliVersion);
      if (strict && validatedCache.data.current === false) throw new Error('负责人规则正在同步 GitHub，真实执行暂时停住，请稍后重试');
      await writeJsonAtomic(manifestFile, {...cached, checkedAt: new Date().toISOString()});
      return {ok: true, updated: false, current: validatedCache.data.current !== false, manifest: validatedCache.data, cacheDir: root, source: 'cache-304'};
    }

    const data = manifestResult.json?.data || manifestResult.json;
    if (!data?.ready || !data?.fingerprint || !data?.bundleSha256) throw new Error('负责人规则包尚未完成发布');
    const recommended = checkCliVersion(data, cliVersion);
    if (validatedCache) assertManifestNotOlder(data, validatedCache.data);
    const cacheMatches = validatedCache?.data?.fingerprint === data.fingerprint
      && validatedCache?.data?.sourceCommit === data.sourceCommit
      && validatedCache?.data?.bundleSha256 === data.bundleSha256;
    let generation = validatedCache?.generation || '';
    if (!cacheMatches) {
      const bundleResult = await fetchJson(fetchImpl, `${String(baseUrl || '').replace(/\/+$/, '')}/api/owner-knowledge/bundle`, {headers: commonHeaders}, fetchTimeoutMs);
      const bundleData = bundleResult.json?.data || bundleResult.json;
      const bundle = normalizeApiBundle(bundleData);
      validateOwnerKnowledgeDistribution({manifest: manifestForValidation(data), bundle});
      if (bundle.fingerprint !== data.fingerprint || String(bundleData?.manifest?.sourceCommit || data.sourceCommit) !== String(data.sourceCommit || '')) {
        throw new Error('负责人规则 manifest 与 bundle 版本不一致');
      }
      generation = generationId(data.bundleSha256);
      await writeJsonAtomic(generationBundleFile(root, generation), bundle);
    } else {
      generation = generationId(data.bundleSha256);
    }

    const etag = manifestResult.response.headers.get('etag') || '';
    const stored = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      checkedAt: new Date().toISOString(),
      etag,
      cliVersion,
      generation,
      data,
    };
    const latestPointer = await readJson(manifestFile, {});
    const latestValidatedCache = await loadValidatedCache(root, latestPointer);
    if (latestValidatedCache) assertManifestNotOlder(data, latestValidatedCache.data);
    await writeJsonAtomic(manifestFile, stored);
    cached = stored;
    validatedCache = await loadValidatedCache(root, stored);
    if (!validatedCache) throw new Error('负责人规则本地缓存写入后校验失败');
    if (strict && data.current === false) throw new Error('负责人规则正在同步 GitHub，真实执行暂时停住，请稍后重试');
    return {
      ok: true,
      updated: !cacheMatches,
      current: data.current !== false,
      manifest: data,
      cacheDir: root,
      source: cacheMatches ? 'manifest-current' : 'downloaded',
      cliUpdateRecommended: Boolean(recommended && compareBiOpsCliVersions(cliVersion, recommended) < 0),
      recommendedCliVersion: recommended,
      warning: data.current === false ? '负责人规则正在同步 GitHub；云端任务仍会使用当前 active 规则，真实 execute 暂停' : '',
    };
  } catch (error) {
    validatedCache = validatedCache || await loadValidatedCache(root, cached);
    if (!strict && [404, 501].includes(Number(error?.status || 0))) {
      return {
        ok: false,
        updated: false,
        current: false,
        unsupported: true,
        manifest: validatedCache?.data || null,
        cacheDir: root,
        source: validatedCache ? 'stale-cache' : 'server-without-manifest',
        warning: '云端尚未提供负责人规则 manifest；服务端任务规则仍会照常生效',
      };
    }
    if (strict || !validatedCache) throw error;
    return {
      ok: false,
      updated: false,
      current: false,
      stale: true,
      manifest: validatedCache.data,
      cacheDir: root,
      source: 'stale-cache',
      warning: String(error?.message || error),
    };
  }
}

export async function ensurePartnerKnowledgeCurrent({
  baseUrl,
  cookie,
  cacheDir = DEFAULT_PARTNER_KNOWLEDGE_CACHE_DIR,
  fetchImpl = globalThis.fetch,
  cliVersion = BI_OPS_CLI_VERSION,
  strict = false,
  fetchTimeoutMs = 60_000,
  lockOptions = {},
  maxAgeMs = 0,
} = {}) {
  const root = path.resolve(cacheDir);
  if (Number(maxAgeMs) > 0) {
    const cached = await readJson(path.join(root, 'manifest.json'), {});
    const validatedCache = await loadValidatedCache(root, cached);
    const checkedAt = Date.parse(String(cached.checkedAt || ''));
    if (validatedCache
      && Number.isFinite(checkedAt)
      && Date.now() - checkedAt >= 0
      && Date.now() - checkedAt <= Number(maxAgeMs)) {
      const recommended = checkCliVersion(validatedCache.data, cliVersion);
      if (strict && validatedCache.data.current === false) throw new Error('负责人规则正在同步 GitHub，真实执行暂时停住，请稍后重试');
      return {
        ok: true,
        updated: false,
        current: validatedCache.data.current !== false,
        manifest: validatedCache.data,
        cacheDir: root,
        source: 'fresh-check-cache',
        checkedAt: cached.checkedAt,
        cliUpdateRecommended: Boolean(recommended && compareBiOpsCliVersions(cliVersion, recommended) < 0),
        recommendedCliVersion: recommended,
      };
    }
  }
  const release = await acquireCacheLock(root, lockOptions);
  try {
    return await ensurePartnerKnowledgeCurrentLocked({baseUrl, cookie, root, fetchImpl, cliVersion, strict, fetchTimeoutMs});
  } finally {
    await release();
  }
}
