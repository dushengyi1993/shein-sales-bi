import pg from 'pg';

const {Pool} = pg;

const DEFAULT_APPLICATION_NAME = 'shein-link-ops';
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 10;

export class WarehousePgConfigurationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'WarehousePgConfigurationError';
    this.code = 'WAREHOUSE_PG_CONFIGURATION';
  }
}

export class WarehousePgUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'WarehousePgUnavailableError';
    this.code = 'WAREHOUSE_PG_UNAVAILABLE';
  }
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new WarehousePgConfigurationError(`${label} must be a positive integer`);
  }
  return parsed;
}

function optionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function parseSslMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (!mode || mode === 'disable') return undefined;
  if (['require', 'prefer', 'allow'].includes(mode)) return {rejectUnauthorized: false};
  if (['verify-ca', 'verify-full'].includes(mode)) return {rejectUnauthorized: true};
  throw new WarehousePgConfigurationError(`Unsupported PostgreSQL SSL mode: ${mode}`);
}

/**
 * Build node-postgres configuration exclusively from environment variables.
 * A password is never accepted as a function option; use PGPASSWORD,
 * SHEIN_WAREHOUSE_PG_PASSWORD, PGPASSFILE, or a service EnvironmentFile.
 */
export function warehousePgConfigFromEnv(env = process.env) {
  const connectionString = optionalString(
    env.SHEIN_WAREHOUSE_PG_URL
    || env.SHEIN_BI_DATABASE_URL
    || env.DATABASE_URL
  );
  const password = optionalString(env.SHEIN_WAREHOUSE_PG_PASSWORD || env.PGPASSWORD);
  const applicationName = optionalString(env.SHEIN_WAREHOUSE_PG_APPLICATION_NAME)
    || DEFAULT_APPLICATION_NAME;
  const common = {
    application_name: applicationName,
    connectionTimeoutMillis: positiveInteger(
      env.SHEIN_WAREHOUSE_PG_CONNECTION_TIMEOUT_MS,
      DEFAULT_CONNECTION_TIMEOUT_MS,
      'SHEIN_WAREHOUSE_PG_CONNECTION_TIMEOUT_MS'
    ),
    idleTimeoutMillis: positiveInteger(
      env.SHEIN_WAREHOUSE_PG_IDLE_TIMEOUT_MS,
      DEFAULT_IDLE_TIMEOUT_MS,
      'SHEIN_WAREHOUSE_PG_IDLE_TIMEOUT_MS'
    ),
    max: positiveInteger(
      env.SHEIN_WAREHOUSE_PG_POOL_MAX,
      DEFAULT_MAX_CONNECTIONS,
      'SHEIN_WAREHOUSE_PG_POOL_MAX'
    ),
    ssl: parseSslMode(env.SHEIN_WAREHOUSE_PG_SSLMODE || env.PGSSLMODE),
  };
  if (!common.ssl) delete common.ssl;

  if (connectionString) {
    return {
      ...common,
      connectionString,
      ...(password ? {password} : {}),
    };
  }

  const host = optionalString(env.SHEIN_WAREHOUSE_PG_HOST || env.PGHOST);
  const database = optionalString(env.SHEIN_WAREHOUSE_PG_DATABASE || env.PGDATABASE);
  const user = optionalString(env.SHEIN_WAREHOUSE_PG_USER || env.PGUSER);
  if (!host || !database || !user) {
    throw new WarehousePgConfigurationError(
      'PostgreSQL mode requires SHEIN_WAREHOUSE_PG_URL (or DATABASE_URL), or PGHOST/PGDATABASE/PGUSER. Credentials must come from env/EnvironmentFile.'
    );
  }
  return {
    ...common,
    host,
    port: positiveInteger(env.SHEIN_WAREHOUSE_PG_PORT || env.PGPORT, 5432, 'PGPORT'),
    database,
    user,
    ...(password ? {password} : {}),
  };
}

export function createWarehousePgPool({env = process.env, PoolClass = Pool} = {}) {
  if (typeof PoolClass !== 'function') throw new TypeError('PoolClass must be a constructor');
  const pool = new PoolClass(warehousePgConfigFromEnv(env));
  pool.on?.('error', () => {
    // node-postgres requires an error listener for idle-client failures. Callers
    // still receive query/connect failures; this intentionally does not fall
    // back to JSON or hide an unavailable database.
  });
  return pool;
}

export function isPgConnectivityError(error) {
  const code = String(error?.code || '');
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ETIMEDOUT',
    '57P01',
    '57P02',
    '57P03',
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '08P01',
  ].includes(code) || /^08/.test(code);
}

export function wrapPgError(error, operation = 'PostgreSQL operation') {
  if (error instanceof WarehousePgConfigurationError || error instanceof WarehousePgUnavailableError) return error;
  if (!isPgConnectivityError(error)) return error;
  return new WarehousePgUnavailableError(`${operation} failed because PostgreSQL is unavailable`, {cause: error});
}

function assertQueryable(value) {
  if (!value || typeof value.query !== 'function') {
    throw new TypeError('A node-postgres Pool or Client with query() is required');
  }
  return value;
}

function isPoolLike(value) {
  return Boolean(value && typeof value.connect === 'function' && typeof value.release !== 'function');
}

export async function withPgClient(source, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');
  if (isPoolLike(source)) {
    let client;
    try {
      client = await source.connect();
      return await callback(assertQueryable(client));
    } catch (error) {
      throw wrapPgError(error, 'PostgreSQL connection');
    } finally {
      client?.release?.();
    }
  }
  try {
    return await callback(assertQueryable(source));
  } catch (error) {
    throw wrapPgError(error);
  }
}

const ISOLATION_LEVELS = new Map([
  ['read committed', 'READ COMMITTED'],
  ['repeatable read', 'REPEATABLE READ'],
  ['serializable', 'SERIALIZABLE'],
]);

export async function withPgTransaction(source, callback, {
  advisoryLockKey = '',
  isolationLevel = 'read committed',
  readOnly = false,
} = {}) {
  const isolation = ISOLATION_LEVELS.get(String(isolationLevel || '').trim().toLowerCase());
  if (!isolation) throw new TypeError(`Unsupported transaction isolation level: ${isolationLevel}`);
  return withPgClient(source, async client => {
    await client.query('BEGIN');
    try {
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}${readOnly ? ' READ ONLY' : ''}`);
      if (advisoryLockKey) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
          [String(advisoryLockKey)]
        );
      }
      const value = await callback(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        if (error && typeof error === 'object' && !error.rollbackError) error.rollbackError = rollbackError;
      }
      throw error;
    }
  });
}

export async function acquirePgSessionAdvisoryLock(client, key) {
  assertQueryable(client);
  const lockKey = String(key || '').trim();
  if (!lockKey) throw new TypeError('Session advisory lock key is required');
  await client.query('SELECT pg_advisory_lock(hashtextextended($1::text, 0))', [lockKey]);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await client.query('SELECT pg_advisory_unlock(hashtextextended($1::text, 0))', [lockKey]);
  };
}

export async function closeWarehousePg(source) {
  if (source && typeof source.end === 'function') await source.end();
}

export async function checkWarehousePg(source) {
  return withPgClient(source, async client => {
    const result = await client.query(
      "SELECT current_database() AS database, current_user AS user_name, now() AS checked_at"
    );
    return {ok: true, ...(result.rows?.[0] || {})};
  });
}
