import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const META_DIR = path.join(ROOT, 'infra', 'metabase');
const CRED_PATH = path.join(META_DIR, '.admin.local.json');
const SESSION_PATH = path.join(META_DIR, '.session.local.json');
const ENV_PATH = path.join(META_DIR, '.env');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');

function readEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=\s]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function ensureIgnored() {
  const patterns = ['infra/metabase/.admin.local.json', 'infra/metabase/.session.local.json'];
  let s = fs.existsSync(GITIGNORE_PATH) ? fs.readFileSync(GITIGNORE_PATH, 'utf8') : '';
  let changed = false;
  for (const p of patterns) {
    if (!s.split(/\r?\n/).includes(p)) {
      s += (s.endsWith('\n') || s.length === 0 ? '' : '\n') + p + '\n';
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(GITIGNORE_PATH, s, 'utf8');
}

function loadAdminCredential() {
  if (fs.existsSync(CRED_PATH)) return JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
  const cred = {
    email: 'admin@shein-bi.local',
    first_name: 'SHEIN',
    last_name: 'BI',
    password: crypto.randomBytes(18).toString('base64url') + '8a',
    created_at: new Date().toISOString()
  };
  fs.writeFileSync(CRED_PATH, JSON.stringify(cred, null, 2), 'utf8');
  return cred;
}

function detectMetabaseUrl() {
  if (process.env.METABASE_URL) return process.env.METABASE_URL.replace(/\/$/, '');
  try {
    const ipText = execFileSync('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'hostname', '-I'], { encoding: 'utf8' }).trim();
    const ip = ipText.split(/\s+/).find(Boolean);
    if (ip) return `http://${ip}:3000`;
  } catch {}
  return 'http://localhost:3000';
}

async function api(baseUrl, pathname, opts = {}) {
  const res = await fetch(baseUrl + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${pathname} -> ${res.status}: ${text.slice(0, 1200)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function main() {
  ensureIgnored();
  const baseUrl = detectMetabaseUrl();
  const env = readEnv(ENV_PATH);
  const cred = loadAdminCredential();
  const props = await api(baseUrl, '/api/session/properties');
  let sessionId = null;

  if (!(props['has-user-setup?'] || props['has-user-setup']) && props['setup-token']) {
    const setupPayload = {
      token: props['setup-token'],
      user: {
        first_name: cred.first_name,
        last_name: cred.last_name,
        email: cred.email,
        password: cred.password
      },
      prefs: {
        site_name: 'SHEIN BI',
        site_locale: 'zh_CN',
        allow_tracking: false
      }
    };
    try {
      const setup = await api(baseUrl, '/api/setup', { method: 'POST', body: JSON.stringify(setupPayload) });
      sessionId = setup.id || setup.session_id || setup['session-id'] || null;
    } catch (err) {
      if (err.status !== 403) throw err;
    }
  }

  if (!sessionId) {
    const login = await api(baseUrl, '/api/session', {
      method: 'POST',
      body: JSON.stringify({ username: cred.email, password: cred.password })
    });
    sessionId = login.id;
  }

  const auth = { 'X-Metabase-Session': sessionId };
  const dbs = await api(baseUrl, '/api/database', { headers: auth });
  const dbList = dbs.data || dbs;
  let warehouse = Array.isArray(dbList) ? dbList.find(d => d.name === 'SHEIN BI Warehouse') : null;
  if (!warehouse) {
    warehouse = await api(baseUrl, '/api/database', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'SHEIN BI Warehouse',
        engine: 'postgres',
        details: {
          host: 'warehouse-db',
          port: 5432,
          dbname: env.WAREHOUSE_DB_NAME || 'shein_bi',
          user: env.WAREHOUSE_DB_USER || 'shein',
          password: env.WAREHOUSE_DB_PASSWORD,
          ssl: false,
          'tunnel-enabled': false,
          'advanced-options': false
        },
        is_full_sync: true,
        is_on_demand: false,
        auto_run_queries: true,
        schedules: {}
      })
    });
  }

  fs.writeFileSync(SESSION_PATH, JSON.stringify({ sessionId, metabaseUrl: baseUrl, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  const health = await api(baseUrl, '/api/health');
  console.log(JSON.stringify({ ok: true, metabaseUrl: baseUrl, health, database: { id: warehouse.id, name: warehouse.name, engine: warehouse.engine } }, null, 2));
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});

