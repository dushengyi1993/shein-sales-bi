#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${SHEIN_WAREHOUSE_CONTAINER:-shein-warehouse-db}"
DATABASE="${SHEIN_WAREHOUSE_DATABASE:-shein_bi}"
ADMIN_USER="${SHEIN_WAREHOUSE_ADMIN_USER:-shein}"
ROLE="shein_webhook_ops"
ENV_FILE="${SHEIN_WEBHOOK_ENV_FILE:-/srv/shein-bi/secrets/webhook-warehouse.env}"
ENV_DIR_GROUP="${SHEIN_WEBHOOK_ENV_DIR_GROUP:-sheinops}"

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
# The directory is shared with the Portal's runtime-readable htpasswd and
# portal-warehouse files. Keep group traversal while the webhook credential
# itself remains root-only below. Re-provisioning must never chmod the shared
# directory to 0700 and take the Portal offline.
install -d -m 0750 -o root -g "${ENV_DIR_GROUP}" "$(dirname "${ENV_FILE}")"
temporary="${ENV_FILE}.tmp.$$"
trap 'rm -f "${temporary}"' EXIT
printf 'SHEIN_WAREHOUSE_PG_PASSWORD=%s\n' "${password}" >"${temporary}"
chown root:root "${temporary}"
chmod 0600 "${temporary}"

# The generated password is hexadecimal, so this single-quoted SQL literal is
# safe.  It travels over stdin only and is never printed or placed in argv.
{
  cat <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN;
  END IF;
END
\$\$;

ALTER ROLE ${ROLE} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION PASSWORD '${password}';
ALTER ROLE ${ROLE} SET statement_timeout = '30s';
ALTER ROLE ${ROLE} SET lock_timeout = '5s';
ALTER ROLE ${ROLE} SET idle_in_transaction_session_timeout = '15s';
GRANT CONNECT ON DATABASE ${DATABASE} TO ${ROLE};
SQL
} | docker exec -i "${CONTAINER}" psql -U "${ADMIN_USER}" -d "${DATABASE}" -v ON_ERROR_STOP=1 >/dev/null

mv -f "${temporary}" "${ENV_FILE}"
trap - EXIT
echo "Provisioned PostgreSQL role ${ROLE}; run the webhook migration next."
