#!/usr/bin/env bash
set -Eeuo pipefail

# Local (fnOS) execution entry for the bounded SHEIN marketing repair lane.
#
# The cloud coordinator inspects marketing every morning, but when the cloud
# cannot start a run it defers with `deferred_to_local`. After the services move
# to fnOS there is no longer a "local side" that consumes that deferral: the two
# local Codex automations (shein-4, v7) are read-only 11:30 summaries and are
# explicitly forbidden from scanning, enrolling or repricing.
#
# This entry is the local executor, and it deliberately owns no gating logic.
# It reuses the cloud slot's authorization verification, deadlines, shared
# host-heavy lane and bounded worker, so the two paths cannot drift:
#
#   * an explicit opt-in (`SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=local`)
#     proves the caller is the local executor rather than the cloud timer;
#   * a root-created immediate-authorization artifact must already exist, so a
#     local run can never invent work or bypass the standing authorization;
#   * a same-day queue must already exist, so an idle day writes nothing.
#
# Usage:
#   SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=local \
#     bash scripts/run_local_marketing_repair_slot.sh
#
# Exit 75 means "nothing to do here" (no queue, or no authorization yet); the
# caller must report that, not retry it as a failure.

ROOT="${SHEIN_BI_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
EXECUTION_LOCATION="${SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION:-cloud}"
STATE_DIR="${SHEIN_BI_MARKETING_LIVE_STATE_DIR:-$ROOT/state/cloud_marketing_live_guard}"
IMMEDIATE_AUTHORIZATION_FILE="${SHEIN_BI_MARKETING_IMMEDIATE_AUTHORIZATION_FILE:-/srv/shein-bi/marketing-repair-immediate/authorization.json}"
TODAY="$(TZ="$TZ_NAME" date +%F)"
QUEUE_FILE="$STATE_DIR/repair-queues/marketing-repair-${TODAY}.json"

if [[ "$EXECUTION_LOCATION" != "local" ]]; then
  echo "[local-marketing-slot] refusing: set SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=local to run the local executor (current=${EXECUTION_LOCATION})" >&2
  exit 64
fi

if [[ ! -f "$QUEUE_FILE" ]]; then
  echo "[local-marketing-slot] no same-day repair queue for $TODAY at $QUEUE_FILE; deferring" >&2
  exit 75
fi

if [[ ! -e "$IMMEDIATE_AUTHORIZATION_FILE" && ! -L "$IMMEDIATE_AUTHORIZATION_FILE" ]]; then
  echo "[local-marketing-slot] no immediate authorization at $IMMEDIATE_AUTHORIZATION_FILE; the local executor never invents work, deferring" >&2
  exit 75
fi

export SHEIN_BI_MARKETING_REPAIR_EXECUTION_LOCATION=local
# Force the explicitly authorized immediate path; the cloud slot rejects
# immediate mode without the hash-bound authorization artifact, so this stays
# fail-closed even if the artifact disappears between the checks above.
export SHEIN_BI_MARKETING_IMMEDIATE_RUN=true
export SHEIN_BI_MARKETING_CLOUD_PRIMARY_ENABLED=false

exec /usr/bin/env bash "$ROOT/scripts/run_cloud_marketing_fallback_slot.sh"
