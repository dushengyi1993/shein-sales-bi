#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'shein_openapi.local.json');
const DEFAULT_OUT = path.join(ROOT, 'state', 'openapi-probes', 'read-probes.latest.json');
const DEFAULT_STORES = ['CX', 'DL', 'DX', 'FY', 'HL', 'JSH', 'JY', 'LQ', 'MZ', 'NM', 'QH', 'QY', 'TS', 'TZ', 'TZZ', 'XC', 'XL', 'YJ', 'ZL'];

function parseArgs(argv) {
  const args = {
    config: DEFAULT_CONFIG,
    stores: [],
    out: DEFAULT_OUT,
    timeoutMs: 120_000,
    includePending: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') args.config = path.resolve(argv[++i]);
    else if (a === '--stores') args.stores = String(argv[++i] || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--no-out') args.out = '';
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--only-configured') args.includePending = false;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage:
  node scripts/probe_shein_openapi_all_stores.mjs [--stores HL,ZL] [--only-configured] [--out state/openapi-probes/read-probes.latest.json]

Runs the single-store read-only OpenAPI probe for authorized stores. Pending
stores are reported as pending_authorization; no secrets are printed. By
default it writes a sanitized latest summary for the BI OpenAPI capability
ledger; pass --no-out to only print to stdout.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function isAuthorized(entry) {
  return Boolean(entry?.enabled)
    && Boolean(String(entry?.openKeyId || '').trim())
    && Boolean(String(entry?.secretKey || '').trim());
}

function runStoreProbe(storeKey, args) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'probe_shein_openapi_store.mjs'),
      '--config', args.config,
      '--store', storeKey,
    ], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, Math.max(30_000, Number(args.timeoutMs || 120_000)));
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let parsed = null;
      const text = stdout.trim();
      try {
        parsed = JSON.parse(text);
      } catch {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
          try { parsed = JSON.parse(text.slice(start, end + 1)); } catch {}
        }
      }
      const summary = Array.isArray(parsed?.summary) ? parsed.summary.map(x => ({
        name: x.name,
        httpStatus: x.httpStatus ?? null,
        code: x.code ?? null,
        msg: x.msg ?? null,
        count: x.count ?? null,
      })) : [];
      const endpointOk = summary.length > 0 && summary.every(x => {
        const http = Number(x.httpStatus);
        const apiCode = x.code == null ? '0' : String(x.code);
        return Number.isFinite(http) && http >= 200 && http < 300 && apiCode === '0';
      });
      const ok = Boolean(parsed?.ok) && endpointOk;
      resolve({
        storeKey,
        status: ok ? 'read_probe_ok' : 'read_probe_failed',
        ok,
        code,
        signal: signal || null,
        startedAt,
        endedAt: new Date().toISOString(),
        savedTo: parsed?.savedTo || '',
        summary,
        stderrTail: stderr.slice(-1200),
        stdoutTail: parsed ? '' : stdout.slice(-1200),
      });
    });
  });
}

const args = parseArgs(process.argv.slice(2));
const config = await readJson(args.config, {});
const configured = new Map((Array.isArray(config?.stores) ? config.stores : [])
  .map(entry => [String(entry?.storeKey || '').trim().toUpperCase(), entry])
  .filter(([key]) => key));
const stores = (args.stores.length ? args.stores : DEFAULT_STORES).filter((x, i, arr) => arr.indexOf(x) === i);
const results = [];
for (const storeKey of stores) {
  const entry = configured.get(storeKey);
  if (!isAuthorized(entry)) {
    if (args.includePending) {
      results.push({
        storeKey,
        status: entry ? 'configured_disabled_or_incomplete' : 'pending_authorization',
        ok: false,
        configured: Boolean(entry),
        enabled: Boolean(entry?.enabled),
      });
    }
    continue;
  }
  results.push(await runStoreProbe(storeKey, args));
}

const output = {
  schemaVersion: 'shein-openapi-read-probe-summary/v1',
  ok: results.every(r => r.ok || r.status === 'pending_authorization' || r.status === 'configured_disabled_or_incomplete'),
  generatedAt: new Date().toISOString(),
  storesRequested: stores,
  counts: results.reduce((acc, r) => {
    acc.total += 1;
    if (r.ok) acc.readProbeOk += 1;
    if (r.status === 'pending_authorization' || r.status === 'configured_disabled_or_incomplete') acc.pending += 1;
    if (r.status === 'read_probe_failed') acc.failed += 1;
    return acc;
  }, {total: 0, readProbeOk: 0, pending: 0, failed: 0}),
  results,
};

if (args.out) {
  await fs.mkdir(path.dirname(args.out), {recursive: true});
  await fs.writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify(output, null, 2));
