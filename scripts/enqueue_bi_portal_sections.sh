#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
QUEUE_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_FILE:-$ROOT/state/portal-section-queue/queue.json}"
LOCK_FILE="${SHEIN_BI_PORTAL_SECTION_QUEUE_LOCK_FILE:-$ROOT/state/locks/shein-bi-portal-section-queue.lock}"
PORTAL_DATA_PATH="${SHEIN_BI_PORTAL_DATA_PATH:-$ROOT/outputs/bi-portal/data.json}"

COMMAND="enqueue"
if [[ "${1:-}" == "reconcile-generation" ]]; then
  COMMAND="$1"
  shift
fi

has_core_generated_at=0
for argument in "$@"; do
  if [[ "$argument" == "--core-generated-at" ]]; then
    has_core_generated_at=1
    break
  fi
done

source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"

locked_manager() {
  local output
  local status
  exec 9<>"$LOCK_FILE"
  if ! flock -w 10 9; then
    echo "[portal-section-queue] $COMMAND lock busy" >&2
    exec 9>&-
    return 75
  fi
  set +e
  output="$(node "$ROOT/scripts/manage_bi_portal_section_queue.mjs" "$@" --file "$QUEUE_FILE")"
  status=$?
  set -e
  flock -u 9
  exec 9>&-
  printf '%s\n' "$output"
  return "$status"
}

if [[ "$COMMAND" == "reconcile-generation" ]]; then
  if [[ "$has_core_generated_at" -eq 0 ]]; then
    echo "[portal-section-queue] reconcile-generation requires --core-generated-at" >&2
    exit 64
  fi
  SNAPSHOT="$(locked_manager reconcile-generation --phase snapshot "$@")" || exit $?
  READY="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.readyForValidation === true ? "1" : "0")' "$SNAPSHOT")" || exit 70
  if [[ "$READY" != "1" ]]; then
    printf '%s\n' "$SNAPSHOT"
    exit 0
  fi
  SNAPSHOT_HASH="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.snapshotHash || ""))' "$SNAPSHOT")" || exit 70
  VALIDATION="$(node "$ROOT/scripts/manage_bi_portal_section_queue.mjs" reconcile-generation \
    --phase validate --snapshot-hash "$SNAPSHOT_HASH" --file "$QUEUE_FILE" "$@")" || exit $?
  VALIDATION_RESULT="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.validationResult || ""))' "$VALIDATION")" || exit 70
  locked_manager reconcile-generation --phase commit \
    --snapshot-hash "$SNAPSHOT_HASH" --validation-result "$VALIDATION_RESULT" "$@"
  exit $?
fi

exec 9<>"$LOCK_FILE"
if ! flock -w 10 9; then
  echo "[portal-section-queue] $COMMAND lock busy" >&2
  exit 75
fi

if [[ "$COMMAND" == "enqueue" && "$has_core_generated_at" -eq 0 ]]; then
  CORE_GENERATED_AT="$(node --input-type=module - "$ROOT" "$PORTAL_DATA_PATH" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2]);
const file = path.resolve(process.argv[3]);
let handle;
try {
  const scannerUrl = pathToFileURL(path.join(root, 'lib', 'bounded_top_level_json.mjs')).href;
  const {scanBoundedTopLevelJson} = await import(scannerUrl);
  handle = await fs.open(file, 'r');
  const stat = await handle.stat();
  if (Number(stat.size || 0) <= 0) throw new Error('BI core file is empty');
  const scan = await scanBoundedTopLevelJson(
    handle.createReadStream({start: 0, autoClose: false}),
    {generatedAt: 4 * 1024},
  );
  const generatedAt = scan.fields.generatedAt?.value;
  if (typeof generatedAt !== 'string' || !/^[\x21-\x7E]{1,1024}$/.test(generatedAt)) {
    throw new Error('BI core generatedAt is not an exact bounded string');
  }
  process.stdout.write(generatedAt);
} catch {
  process.exitCode = 64;
} finally {
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch {
      process.exitCode = 64;
    }
  }
}
NODE
)" || {
    echo "[portal-section-queue] current core generatedAt unavailable: $PORTAL_DATA_PATH" >&2
    exit 64
  }
  if [[ -z "$CORE_GENERATED_AT" ]]; then
    echo "[portal-section-queue] current core generatedAt unavailable: $PORTAL_DATA_PATH" >&2
    exit 64
  fi
  set -- "$@" --core-generated-at "$CORE_GENERATED_AT"
fi

exec node "$ROOT/scripts/manage_bi_portal_section_queue.mjs" "$COMMAND" \
  --file "$QUEUE_FILE" \
  "$@"
