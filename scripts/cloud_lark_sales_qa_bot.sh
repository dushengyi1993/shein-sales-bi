#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
LOG_DIR="${SHEIN_QA_LOG_DIR:-/srv/shein-bi/logs/lark-sales-qa}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"

mkdir -p "$LOG_DIR"
cd "$ROOT"

echo "[cloud_lark_sales_qa_bot] start root=$ROOT stamp=$STAMP"

# lark-cli event consume exits if stdin is EOF. Keep its stdin open with tail.
lark-cli event consume im.message.receive_v1 --as bot < <(tail -f /dev/null) \
  | node scripts/lark_sales_qa_bot.mjs --consume
