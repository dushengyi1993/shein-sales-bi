#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${SHEIN_WAREHOUSE_CONTAINER:-shein-warehouse-db}"
DATABASE="${SHEIN_WAREHOUSE_DATABASE:-shein_bi}"
ADMIN_USER="${SHEIN_WAREHOUSE_ADMIN_USER:-shein}"
ROLE="shein_link_ops"
ENV_FILE="${SHEIN_LINK_OPS_ENV_FILE:-/srv/shein-bi/secrets/portal-warehouse.env}"
ENV_GROUP="${SHEIN_LINK_OPS_ENV_GROUP:-sheinops}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This provisioning script must run as root." >&2
  exit 1
fi
if [[ ! "${ROLE}" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "Unsafe PostgreSQL role name" >&2
  exit 1
fi

umask 0077
password="$(openssl rand -hex 32)"
install -d -m 0750 -o root -g "${ENV_GROUP}" "$(dirname "${ENV_FILE}")"
temporary="${ENV_FILE}.tmp.$$"
trap 'rm -f "${temporary}"' EXIT
printf 'SHEIN_WAREHOUSE_PG_PASSWORD=%s\n' "${password}" >"${temporary}"
chown root:"${ENV_GROUP}" "${temporary}"
chmod 0640 "${temporary}"

# The generated password is hexadecimal, so embedding it in this single-quoted
# SQL literal is safe. It travels only over stdin and is never printed or put in
# a process argument.
{
  cat <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN;
  END IF;
END
\$\$;

ALTER ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
ALTER ROLE ${ROLE} SET statement_timeout = '30s';
ALTER ROLE ${ROLE} SET lock_timeout = '5s';
ALTER ROLE ${ROLE} SET idle_in_transaction_session_timeout = '15s';

GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLE};
GRANT USAGE ON SCHEMA ops TO ${ROLE};
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA ops TO ${ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ops TO ${ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA ops GRANT SELECT, INSERT, UPDATE ON TABLES TO ${ROLE};
ALTER DEFAULT PRIVILEGES IN SCHEMA ops GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE};

REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA ops FROM ${ROLE};
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ops.link_ops_event FROM ${ROLE};
GRANT SELECT, INSERT ON ops.link_ops_event TO ${ROLE};
SQL
} | docker exec -i "${CONTAINER}" psql -U "${ADMIN_USER}" -d "${DATABASE}" -v ON_ERROR_STOP=1 >/dev/null

mv -f "${temporary}" "${ENV_FILE}"
trap - EXIT
echo "Provisioned restricted PostgreSQL role ${ROLE}; secret file installed at ${ENV_FILE}."
