#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
STAGE=""
RUN_DATE_TARGET="today"
BUSINESS_DATE_TARGET=""
MESSAGE=""
EVIDENCE=()
REQUIRES=()

usage() {
  cat >&2 <<'EOF'
Usage:
  run_pipeline_stage.sh --stage NAME [--run-date today|yesterday|YYYY-MM-DD]
    [--business-date today|yesterday|YYYY-MM-DD]
    [--require STAGE] [--message TEXT] [--evidence PATH] -- COMMAND [ARG...]
EOF
  exit 64
}

resolve_date() {
  case "$1" in
    today) TZ="$TZ_NAME" date +%F ;;
    yesterday) TZ="$TZ_NAME" date -d yesterday +%F ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) printf '%s\n' "$1" ;;
    *) return 64 ;;
  esac
}

write_marker() {
  local status="$1"
  local marker_message="$2"
  local args=(
    write
    --stage "$STAGE"
    --date "$RUN_DATE"
    --business-date "$BUSINESS_DATE"
    --status "$status"
    --message "$marker_message"
  )
  local evidence
  for evidence in "${EVIDENCE[@]}"; do
    args+=(--evidence "$evidence")
  done
  node "$ROOT/scripts/pipeline_marker.mjs" "${args[@]}"
}

while (($#)); do
  case "$1" in
    --stage)
      (($# >= 2)) || usage
      STAGE="$2"
      shift 2
      ;;
    --run-date)
      (($# >= 2)) || usage
      RUN_DATE_TARGET="$2"
      shift 2
      ;;
    --business-date)
      (($# >= 2)) || usage
      BUSINESS_DATE_TARGET="$2"
      shift 2
      ;;
    --require)
      (($# >= 2)) || usage
      REQUIRES+=("$2")
      shift 2
      ;;
    --message)
      (($# >= 2)) || usage
      MESSAGE="$2"
      shift 2
      ;;
    --evidence)
      (($# >= 2)) || usage
      EVIDENCE+=("$2")
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      usage
      ;;
  esac
done

[[ "$STAGE" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]] || usage
(($# > 0)) || usage
RUN_DATE="$(resolve_date "$RUN_DATE_TARGET")" || usage
if [[ -n "$BUSINESS_DATE_TARGET" ]]; then
  BUSINESS_DATE="$(resolve_date "$BUSINESS_DATE_TARGET")" || usage
else
  BUSINESS_DATE="$RUN_DATE"
fi

for required_stage in "${REQUIRES[@]}"; do
  if ! node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage "$required_stage" \
    --date "$RUN_DATE" \
    --status done,warning; then
    echo "[pipeline-stage] deferred stage=$STAGE missingDependency=$required_stage runDate=$RUN_DATE" >&2
    write_marker "deferred" "dependency not ready: $required_stage" >/dev/null
    exit 75
  fi
done

echo "[pipeline-stage] start stage=$STAGE runDate=$RUN_DATE businessDate=$BUSINESS_DATE command=$1"
set +e
"$@"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  write_marker "done" "${MESSAGE:-stage completed}"
elif [[ "$STATUS" -eq 75 ]]; then
  write_marker "deferred" "${MESSAGE:-stage deferred}" >/dev/null
else
  write_marker "failed" "${MESSAGE:-stage failed}; exit=$STATUS" >/dev/null
fi
echo "[pipeline-stage] done stage=$STAGE status=$STATUS"
exit "$STATUS"
