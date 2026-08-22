#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${SHEIN_BI_DB_CONTAINER:-shein-warehouse-db}"
DATABASE="${SHEIN_BI_DB_DATABASE:-shein_bi}"
USER="${SHEIN_BI_DB_USER:-shein}"
APPLICATION_NAME="${SHEIN_BI_DB_APPLICATION_NAME:-}"
SQL_FILE="${SHEIN_BI_PROFIT_MART_REFRESH_SQL:-$ROOT/scripts/refresh_profit_marts.sql}"

if [[ -n "$APPLICATION_NAME" ]] && { [[ ${#APPLICATION_NAME} -gt 63 ]] || [[ ! "$APPLICATION_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,62}$ ]]; }; then
  echo "[refresh_profit_marts] invalid SHEIN_BI_DB_APPLICATION_NAME" >&2
  exit 2
fi

if [[ ! -f "$SQL_FILE" ]]; then
  echo "[refresh_profit_marts] missing sql file: $SQL_FILE" >&2
  exit 2
fi

if [[ "$(id -u)" == "0" ]]; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

START="$(date +%s)"
echo "[refresh_profit_marts] start root=$ROOT container=$CONTAINER database=$DATABASE user=$USER sql=$SQL_FILE"
DB_APPLICATION_ENV=()
if [[ -n "$APPLICATION_NAME" ]]; then
  DB_APPLICATION_ENV=(-e "PGAPPNAME=$APPLICATION_NAME")
fi
"${DOCKER[@]}" exec -i "${DB_APPLICATION_ENV[@]}" "$CONTAINER" psql -U "$USER" -d "$DATABASE" -v ON_ERROR_STOP=1 -P pager=off < "$SQL_FILE"
END="$(date +%s)"
echo "[refresh_profit_marts] done duration_sec=$((END-START))"
