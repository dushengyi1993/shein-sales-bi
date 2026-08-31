#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
MARKER_ROOT="${SHEIN_BI_PIPELINE_MARKER_ROOT:-$ROOT/state/pipeline-markers}"
STAGE=""
RUN_DATE_TARGET="today"
BUSINESS_DATE_TARGET=""
MESSAGE=""
EVIDENCE=()
REQUIRES=()
RUN_DATE_REQUIRES=()
SKIP_IF_DONE=0
WORK_FINGERPRINT=""
WORK_FINGERPRINT_SCOPE=""
WORK_SEMANTIC_VERSION=""
WORK_PARAMETERS=()
WORKSET_DIGEST=""
WORKSET_CANDIDATE_COUNT=""
WORKSET_PAIR_COUNT=""
WORKSET_DIGEST_PROGRAM=""
WORKSET_DIGEST_ARGS=()
SOURCE_COMMIT=""

usage() {
  cat >&2 <<'EOF'
Usage:
  run_pipeline_stage.sh --stage NAME [--run-date today|yesterday|YYYY-MM-DD]
    [--business-date today|yesterday|YYYY-MM-DD]
    [--require STAGE] [--require-run-date STAGE] [--message TEXT] [--evidence PATH]
    [--skip-if-done --work-fingerprint-scope NAME --work-semantic-version VERSION]
    [--work-parameter KEY=VALUE]
    [--workset-digest-program PROGRAM --workset-digest-arg ARG]
    [--source-commit COMMIT] -- COMMAND [ARG...]
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
    --root "$MARKER_ROOT"
  )
  if [[ -n "$WORK_FINGERPRINT" ]]; then
    args+=(
      --work-fingerprint "$WORK_FINGERPRINT"
      --work-fingerprint-scope "$WORK_FINGERPRINT_SCOPE"
      --work-semantic-version "$WORK_SEMANTIC_VERSION"
      --workset-digest "$WORKSET_DIGEST"
      --workset-candidate-count "$WORKSET_CANDIDATE_COUNT"
      --workset-pair-count "$WORKSET_PAIR_COUNT"
    )
    local parameter
    for parameter in "${WORK_PARAMETERS[@]}"; do
      args+=(--work-parameter "$parameter")
    done
  fi
  if [[ -n "$SOURCE_COMMIT" ]]; then args+=(--source-commit "$SOURCE_COMMIT"); fi
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
    --require-run-date)
      (($# >= 2)) || usage
      RUN_DATE_REQUIRES+=("$2")
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
    --skip-if-done)
      SKIP_IF_DONE=1
      shift
      ;;
    --work-fingerprint-scope)
      (($# >= 2)) || usage
      WORK_FINGERPRINT_SCOPE="$2"
      shift 2
      ;;
    --work-semantic-version)
      (($# >= 2)) || usage
      WORK_SEMANTIC_VERSION="$2"
      shift 2
      ;;
    --work-parameter)
      (($# >= 2)) || usage
      WORK_PARAMETERS+=("$2")
      shift 2
      ;;
    --workset-digest-program)
      (($# >= 2)) || usage
      WORKSET_DIGEST_PROGRAM="$2"
      shift 2
      ;;
    --workset-digest-arg)
      (($# >= 2)) || usage
      WORKSET_DIGEST_ARGS+=("$2")
      shift 2
      ;;
    --source-commit)
      (($# >= 2)) || usage
      SOURCE_COMMIT="$2"
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
if [[ -n "$WORK_FINGERPRINT_SCOPE" && ! "$WORK_FINGERPRINT_SCOPE" =~ ^[a-z0-9][a-z0-9-]{0,79}$ ]]; then usage; fi
if (( SKIP_IF_DONE == 1 )); then
  [[ -n "$WORK_FINGERPRINT_SCOPE" && -n "$WORK_SEMANTIC_VERSION" && -n "$WORKSET_DIGEST_PROGRAM" ]] || usage
fi
RUN_DATE="$(resolve_date "$RUN_DATE_TARGET")" || usage
if [[ -n "$BUSINESS_DATE_TARGET" ]]; then
  BUSINESS_DATE="$(resolve_date "$BUSINESS_DATE_TARGET")" || usage
else
  BUSINESS_DATE="$RUN_DATE"
fi

refresh_work_identity() {
  local digest_output digest_status fingerprint_status parsed_identity
  set +e
  digest_output="$("$WORKSET_DIGEST_PROGRAM" "${WORKSET_DIGEST_ARGS[@]}")"
  digest_status=$?
  set -e
  if [[ "$digest_status" -ne 0 ]]; then
    echo "[pipeline-stage] ERROR read-only candidate digest failed stage=$STAGE exit=$digest_status" >&2
    return "$digest_status"
  fi
  set +e
  parsed_identity="$(printf '%s\n' "$digest_output" | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => { try { const j=JSON.parse(s); if (j.ok !== true || !/^[a-f0-9]{64}$/i.test(j.worksetDigest || '') || !Number.isSafeInteger(j.candidateCount) || j.candidateCount < 0 || !Number.isSafeInteger(j.pairCount) || j.pairCount < 0) process.exit(2); process.stdout.write([j.worksetDigest.toLowerCase(), j.candidateCount, j.pairCount].join(' ')); } catch { process.exit(2); } });")"
  digest_status=$?
  set -e
  if [[ "$digest_status" -ne 0 ]]; then
    echo "[pipeline-stage] ERROR candidate digest output invalid stage=$STAGE" >&2
    return 1
  fi
  read -r WORKSET_DIGEST WORKSET_CANDIDATE_COUNT WORKSET_PAIR_COUNT <<<"$parsed_identity"
  if [[ ! "$WORKSET_DIGEST" =~ ^[a-f0-9]{64}$ || ! "$WORKSET_CANDIDATE_COUNT" =~ ^[0-9]+$ || ! "$WORKSET_PAIR_COUNT" =~ ^[0-9]+$ ]]; then
    echo "[pipeline-stage] ERROR candidate digest identity invalid stage=$STAGE" >&2
    return 1
  fi
  local fingerprint_args=(
    fingerprint
    --scope "$WORK_FINGERPRINT_SCOPE"
    --semantic-version "$WORK_SEMANTIC_VERSION"
    --workset-digest "$WORKSET_DIGEST"
  )
  local parameter
  for parameter in "${WORK_PARAMETERS[@]}"; do
    fingerprint_args+=(--parameter "$parameter")
  done
  set +e
  WORK_FINGERPRINT="$(node "$ROOT/scripts/pipeline_marker.mjs" "${fingerprint_args[@]}")"
  fingerprint_status=$?
  set -e
  if [[ "$fingerprint_status" -ne 0 || ! "$WORK_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]]; then
    echo "[pipeline-stage] ERROR structured work fingerprint failed stage=$STAGE" >&2
    return 1
  fi
}

if (( SKIP_IF_DONE == 1 )); then
  # This command is invoked by run_host_heavy_job while its host, project and
  # order-closure domain locks are held.  Keep the check here, inside that
  # critical section, so two coordinator processes cannot both pass the check
  # before either one publishes the terminal marker. The SELECT and command are
  # not one database transaction: external writers that do not use this domain
  # lock can change rows between them. A post-run digest is therefore recorded;
  # any later change is detected by the next locked pre-check and fails open to
  # execution rather than being hidden by the marker.
  if ! refresh_work_identity; then
    exit 1
  fi
  echo "[pipeline-stage] candidate identity stage=$STAGE candidates=$WORKSET_CANDIDATE_COUNT selectedPairs=$WORKSET_PAIR_COUNT worksetDigest=$WORKSET_DIGEST semanticVersion=$WORK_SEMANTIC_VERSION"
  MARKER_CHECK_ARGS=(
    require
    --stage "$STAGE"
    --date "$RUN_DATE"
    --business-date "$BUSINESS_DATE"
    --status done
    --work-fingerprint "$WORK_FINGERPRINT"
    --work-fingerprint-scope "$WORK_FINGERPRINT_SCOPE"
    --work-semantic-version "$WORK_SEMANTIC_VERSION"
    --workset-digest "$WORKSET_DIGEST"
    --workset-candidate-count "$WORKSET_CANDIDATE_COUNT"
    --workset-pair-count "$WORKSET_PAIR_COUNT"
    --require-ok
    --root "$MARKER_ROOT"
  )
  for parameter in "${WORK_PARAMETERS[@]}"; do
    MARKER_CHECK_ARGS+=(--work-parameter "$parameter")
  done
  if (( WORKSET_CANDIDATE_COUNT > 0 || WORKSET_PAIR_COUNT > 0 )); then
    MARKER_CHECK_OUTPUT='{"reason":"actionable_candidates_present"}'
    MARKER_CHECK_STATUS=75
  else
    set +e
    MARKER_CHECK_OUTPUT="$(node "$ROOT/scripts/pipeline_marker.mjs" "${MARKER_CHECK_ARGS[@]}" 2>&1)"
    MARKER_CHECK_STATUS=$?
    set -e
  fi
  if [[ "$MARKER_CHECK_STATUS" -eq 0 ]]; then
    echo "[pipeline-stage] skip stage=$STAGE runDate=$RUN_DATE businessDate=$BUSINESS_DATE reason=same-day order closure already completed; marker matched after domain lock"
    exit 0
  fi
  MARKER_CHECK_REASON="$(printf '%s\n' "$MARKER_CHECK_OUTPUT" | node -e "let s=''; process.stdin.on('data', d => s += d).on('end', () => { try { process.stdout.write(JSON.parse(s).reason || 'marker_not_reusable'); } catch { process.stdout.write('marker_validation_failed'); } });" 2>/dev/null || true)"
  echo "[pipeline-stage] marker not reusable stage=$STAGE runDate=$RUN_DATE businessDate=$BUSINESS_DATE reason=${MARKER_CHECK_REASON:-marker_not_reusable}; executing order closure" >&2
fi

for required_stage in "${REQUIRES[@]}"; do
  if ! node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage "$required_stage" \
    --date "$RUN_DATE" \
    --business-date "$BUSINESS_DATE" \
    --root "$MARKER_ROOT" \
    --status done,warning; then
    echo "[pipeline-stage] deferred stage=$STAGE missingDependency=$required_stage runDate=$RUN_DATE" >&2
    write_marker "deferred" "dependency not ready: $required_stage" >/dev/null
    exit 75
  fi
done

for required_stage in "${RUN_DATE_REQUIRES[@]}"; do
  if ! node "$ROOT/scripts/pipeline_marker.mjs" require \
    --stage "$required_stage" \
    --date "$RUN_DATE" \
    --root "$MARKER_ROOT" \
    --status done,warning; then
    echo "[pipeline-stage] deferred stage=$STAGE missingRunDateDependency=$required_stage runDate=$RUN_DATE" >&2
    write_marker "deferred" "run-date dependency not ready: $required_stage" >/dev/null
    exit 75
  fi
done

echo "[pipeline-stage] start stage=$STAGE runDate=$RUN_DATE businessDate=$BUSINESS_DATE command=$1"
set +e
"$@"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  PRE_RUN_WORKSET_DIGEST="$WORKSET_DIGEST"
  PRE_RUN_WORK_FINGERPRINT="$WORK_FINGERPRINT"
  PRE_RUN_WORKSET_CANDIDATE_COUNT="$WORKSET_CANDIDATE_COUNT"
  PRE_RUN_WORKSET_PAIR_COUNT="$WORKSET_PAIR_COUNT"
  if (( SKIP_IF_DONE == 1 )) && ! refresh_work_identity; then
    STATUS=1
    WORKSET_DIGEST="$PRE_RUN_WORKSET_DIGEST"
    WORK_FINGERPRINT="$PRE_RUN_WORK_FINGERPRINT"
    WORKSET_CANDIDATE_COUNT="$PRE_RUN_WORKSET_CANDIDATE_COUNT"
    WORKSET_PAIR_COUNT="$PRE_RUN_WORKSET_PAIR_COUNT"
    write_marker "failed" "${MESSAGE:-stage completed}; post-run candidate digest failed" >/dev/null || true
    echo "[pipeline-stage] ERROR stage=$STAGE command succeeded but post-run candidate digest failed; refusing done marker" >&2
  elif (( SKIP_IF_DONE == 1 && (WORKSET_CANDIDATE_COUNT > 0 || WORKSET_PAIR_COUNT > 0) )); then
    write_marker "partial" "${MESSAGE:-stage completed}; remaining actionable candidates=$WORKSET_CANDIDATE_COUNT selectedPairs=$WORKSET_PAIR_COUNT; next authorized activation required" >/dev/null
    echo "[pipeline-stage] partial stage=$STAGE remainingCandidates=$WORKSET_CANDIDATE_COUNT selectedPairs=$WORKSET_PAIR_COUNT; done marker withheld for next authorized activation"
  else
    write_marker "done" "${MESSAGE:-stage completed}"
  fi
elif [[ "$STATUS" -eq 75 ]]; then
  write_marker "deferred" "${MESSAGE:-stage deferred}" >/dev/null
else
  write_marker "failed" "${MESSAGE:-stage failed}; exit=$STATUS" >/dev/null
fi
echo "[pipeline-stage] done stage=$STAGE status=$STATUS"
exit "$STATUS"
