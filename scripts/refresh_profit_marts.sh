#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${SHEIN_BI_DB_CONTAINER:-shein-warehouse-db}"
DATABASE="${SHEIN_BI_DB_DATABASE:-shein_bi}"
USER="${SHEIN_BI_DB_USER:-shein}"
SQL_FILE="${SHEIN_BI_PROFIT_MART_REFRESH_SQL:-$ROOT/scripts/refresh_profit_marts.sql}"

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
"${DOCKER[@]}" exec -i "$CONTAINER" psql -U "$USER" -d "$DATABASE" -v ON_ERROR_STOP=1 -P pager=off < "$SQL_FILE"
END="$(date +%s)"
echo "[refresh_profit_marts] done duration_sec=$((END-START))"
