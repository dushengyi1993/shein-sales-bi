#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_PATH" != /* ]]; then SCRIPT_PATH="$PWD/$SCRIPT_PATH"; fi
[[ ! -L "$SCRIPT_PATH" ]] || {
  printf '%s\n' 'guard_install_error=installer symlink is not allowed' >&2
  exit 1
}

SCRIPT_DIR="${SCRIPT_PATH%/*}"
ROOT="${SCRIPT_DIR%/*}"
MANAGER="$ROOT/scripts/manage_cloud_maintenance_mode.mjs"
[[ -f "$MANAGER" && ! -L "$MANAGER" ]] || {
  printf '%s\n' 'guard_install_error=maintenance manager is missing or unsafe' >&2
  exit 1
}

exec /usr/bin/node "$MANAGER" install-guards "$@"
