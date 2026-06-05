import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export const DEFAULT_CLOUD_BI_ROOT = '/opt/shein-bi/app';
export const DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS = 30_000;
export const DEFAULT_CLOUD_BI_MAX_BYTES = 120 * 1024 * 1024;

function exists(file) {
  return Boolean(file && fsSync.existsSync(file));
}

function parseLocalDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0),
  );
}

function parseAnyDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const parsed = new Date(s);
  if (Number.isFinite(parsed.getTime())) return parsed;
  return parseLocalDateTime(s);
}

function ageHours(now, then) {
  if (!now || !then) return null;
  return Math.round(((now.getTime() - then.getTime()) / 36_000)) / 100;
}

function rel(root, file) {
  if (!file) return '';
  return path.relative(root, file).replaceAll('\\', '/');
}

async function readJsonIfExists(file, fallback = null) {
  if (!exists(file)) return fallback;
  const text = await fs.readFile(file, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

export async function readBiPortalFileSource({
  root,
  file,
  now = new Date(),
  maxAgeHours = 72,
  label = 'biPortalData',
}) {
  const source = {
    label,
    path: rel(root, file),
    exists: exists(file),
    mtime: '',
    generatedAt: '',
    createdAt: '',
    ageHours: null,
    artifactAgeHours: null,
    dataAgeHours: null,
    status: 'missing',
    transport: 'file',
    fallbackUsed: false,
  };
  if (!source.exists) return {source, data: null};
  const stat = fsSync.statSync(file);
  source.mtime = stat.mtime.toISOString();
  source.artifactAgeHours = ageHours(now, stat.mtime);
  source.ageHours = source.artifactAgeHours;
  try {
    const data = await readJsonIfExists(file, null);
    source.generatedAt = data?.generatedAt || data?.source?.biGeneratedAt || '';
    source.createdAt = data?.createdAt || data?.summary?.createdAt || '';
    source.dataTimestamp = source.generatedAt || source.createdAt || '';
    const dataDate = parseAnyDateTime(source.dataTimestamp);
    source.dataAgeHours = dataDate ? ageHours(now, dataDate) : null;
    source.status = (
      (source.artifactAgeHours !== null && source.artifactAgeHours > maxAgeHours)
      || (source.dataAgeHours !== null && source.dataAgeHours > maxAgeHours)
    ) ? 'stale' : 'ok';
    return {source, data};
  } catch (err) {
    source.status = 'parse_error';
    source.error = err.message;
    return {source, data: null};
  }
}

function sourceFromData(label, sourcePath, data, now, maxAgeHours, extra = {}) {
  const source = {
    label,
    path: sourcePath,
    exists: true,
    mtime: '',
    generatedAt: data?.generatedAt || data?.source?.biGeneratedAt || '',
    createdAt: data?.createdAt || data?.summary?.createdAt || '',
    ageHours: null,
    artifactAgeHours: null,
    dataAgeHours: null,
    status: 'ok',
    ...extra,
  };
  source.dataTimestamp = source.generatedAt || source.createdAt || '';
  const dataDate = parseAnyDateTime(source.dataTimestamp);
  source.dataAgeHours = dataDate ? ageHours(now, dataDate) : null;
  source.ageHours = source.dataAgeHours;
  if (source.dataAgeHours !== null && source.dataAgeHours > maxAgeHours) source.status = 'stale';
  return source;
}

function validateCloudBiSshArgs({cloudBiSsh, cloudBiRoot}) {
  const host = String(cloudBiSsh || '').trim();
  const root = String(cloudBiRoot || DEFAULT_CLOUD_BI_ROOT).trim();
  if (!host) return {ok: false, reason: 'empty_host'};
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return {ok: false, reason: 'invalid_host_alias', host};
  if (!/^\/[A-Za-z0-9._/-]+$/.test(root)) return {ok: false, reason: 'invalid_cloud_bi_root', root};
  return {ok: true, host, root, remotePath: `${root.replace(/\/+$/, '')}/outputs/bi-portal/data.json`};
}

function execFileLimited(command, args, {timeoutMs, maxBytes}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {shell: false});
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let killed = false;
    const fail = err => {
      if (killed) return;
      killed = true;
      child.kill('SIGKILL');
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        fail(new Error(`stdout exceeds max bytes ${maxBytes}`));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      const current = stderrChunks.reduce((n, b) => n + b.length, 0);
      if (current < 64 * 1024) stderrChunks.push(chunk);
    });
    child.on('error', err => {
      clearTimeout(timer);
      if (!killed) {
        killed = true;
        reject(err);
      }
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        reject(new Error(`exit=${code}${stderr ? ` stderr=${stderr.slice(0, 500)}` : ''}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function readCloudBiPortalSource({
  cloudBiSsh,
  cloudBiRoot = DEFAULT_CLOUD_BI_ROOT,
  cloudBiSshTimeoutMs = DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
  cloudBiMaxBytes = DEFAULT_CLOUD_BI_MAX_BYTES,
  now = new Date(),
  maxAgeHours = 72,
  label = 'biPortalData',
}) {
  const validation = validateCloudBiSshArgs({cloudBiSsh, cloudBiRoot});
  const baseSource = {
    label,
    path: validation.ok ? `ssh:${validation.host}:${validation.remotePath}` : '',
    exists: false,
    mtime: '',
    generatedAt: '',
    createdAt: '',
    dataAgeHours: null,
    artifactAgeHours: null,
    ageHours: null,
    status: 'invalid_config',
    transport: 'ssh',
    fallbackUsed: false,
  };
  if (!validation.ok) {
    return {source: {...baseSource, error: validation.reason}, data: null};
  }
  try {
    const text = await execFileLimited('ssh', [validation.host, 'cat', validation.remotePath], {
      timeoutMs: cloudBiSshTimeoutMs,
      maxBytes: cloudBiMaxBytes,
    });
    let data = null;
    try {
      data = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      return {
        source: {
          ...baseSource,
          path: `ssh:${validation.host}:${validation.remotePath}`,
          status: 'parse_error',
          error: err.message,
          host: validation.host,
          remotePath: validation.remotePath,
        },
        data: null,
      };
    }
    const source = sourceFromData(label, `ssh:${validation.host}:${validation.remotePath}`, data, now, maxAgeHours, {
      transport: 'ssh',
      host: validation.host,
      remotePath: validation.remotePath,
      fallbackUsed: false,
      maxBytes: cloudBiMaxBytes,
    });
    return {source, data};
  } catch (err) {
    return {
      source: {
        ...baseSource,
        path: `ssh:${validation.host}:${validation.remotePath}`,
        status: 'fetch_error',
        error: err.message,
        host: validation.host,
        remotePath: validation.remotePath,
      },
      data: null,
    };
  }
}

export async function selectBiPortalSource({
  root,
  biPortalData,
  cloudBiSsh = '',
  cloudBiRoot = DEFAULT_CLOUD_BI_ROOT,
  cloudBiSshTimeoutMs = DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS,
  cloudBiMaxBytes = DEFAULT_CLOUD_BI_MAX_BYTES,
  now = new Date(),
  maxAgeHours = 72,
  label = 'biPortalData',
}) {
  const localPath = path.resolve(root, biPortalData || path.join(root, 'outputs', 'bi-portal', 'data.json'));
  if (!cloudBiSsh) {
    const local = await readBiPortalFileSource({root, file: localPath, now, maxAgeHours, label});
    return {selected: local, diagnostics: []};
  }
  const cloud = await readCloudBiPortalSource({
    cloudBiSsh,
    cloudBiRoot,
    cloudBiSshTimeoutMs,
    cloudBiMaxBytes,
    now,
    maxAgeHours,
    label,
  });
  if (cloud.data && cloud.source.status === 'ok') {
    return {selected: cloud, diagnostics: [{type: 'cloud_selected', source: cloud.source}]};
  }
  const local = await readBiPortalFileSource({root, file: localPath, now, maxAgeHours, label});
  if (local.data && local.source.status === 'ok') {
    local.source.fallbackUsed = true;
    return {
      selected: local,
      diagnostics: [{type: 'cloud_fetch_failed_local_fresh', source: cloud.source}],
    };
  }
  if (cloud.data) {
    return {
      selected: cloud,
      diagnostics: [{type: 'cloud_selected_not_fresh', source: cloud.source}],
    };
  }
  local.source.fallbackUsed = true;
  return {
    selected: local,
    diagnostics: [{type: 'cloud_fetch_failed_local_not_fresh', source: cloud.source}],
  };
}

export function addBiPortalSourceArgs(target, argv, index) {
  const a = argv[index];
  if (a === '--bi-portal-data') {
    target.biPortalData = argv[index + 1];
    return index + 1;
  }
  if (a === '--cloud-bi-ssh') {
    target.cloudBiSsh = String(argv[index + 1] || '').trim();
    return index + 1;
  }
  if (a === '--cloud-bi-root') {
    target.cloudBiRoot = String(argv[index + 1] || '').trim();
    return index + 1;
  }
  if (a === '--cloud-bi-ssh-timeout-ms') {
    target.cloudBiSshTimeoutMs = Number(argv[index + 1]);
    return index + 1;
  }
  if (a === '--cloud-bi-max-bytes') {
    target.cloudBiMaxBytes = Number(argv[index + 1]);
    return index + 1;
  }
  if (a === '--bi-max-age-hours') {
    target.biMaxAgeHours = Number(argv[index + 1]);
    return index + 1;
  }
  return index;
}

export function normalizeBiPortalSourceArgs(args, root) {
  const out = args;
  out.biPortalData = out.biPortalData ? path.resolve(root, out.biPortalData) : path.join(root, 'outputs', 'bi-portal', 'data.json');
  out.cloudBiSsh = String(out.cloudBiSsh || '').trim();
  out.cloudBiRoot = String(out.cloudBiRoot || DEFAULT_CLOUD_BI_ROOT).trim();
  if (!Number.isFinite(out.cloudBiSshTimeoutMs) || out.cloudBiSshTimeoutMs <= 0) out.cloudBiSshTimeoutMs = DEFAULT_CLOUD_BI_SSH_TIMEOUT_MS;
  if (!Number.isFinite(out.cloudBiMaxBytes) || out.cloudBiMaxBytes <= 0) out.cloudBiMaxBytes = DEFAULT_CLOUD_BI_MAX_BYTES;
  if (!Number.isFinite(out.biMaxAgeHours) || out.biMaxAgeHours <= 0) out.biMaxAgeHours = 72;
  return out;
}

export function summarizeBiPortalSourceForReport(selection) {
  const source = selection?.selected?.source || {};
  const data = selection?.selected?.data || {};
  return {
    biGeneratedAt: data.generatedAt || source.generatedAt || '',
    biLinkDate: data.dates?.linkDate || '',
    biLinkUpdatedAt: data.dates?.linkUpdatedAt || data.dates?.linkWarehouseUpdatedAt || '',
    biDataPath: source.path || '',
    biDataTransport: source.transport || 'file',
    biFallbackUsed: Boolean(source.fallbackUsed),
    biStatus: source.status || '',
    biDataAgeHours: source.dataAgeHours ?? null,
    biArtifactAgeHours: source.artifactAgeHours ?? null,
  };
}
