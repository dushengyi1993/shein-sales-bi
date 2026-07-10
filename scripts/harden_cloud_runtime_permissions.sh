#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
OWNER="${SHEIN_BI_RUNTIME_USER:-sheinops}"
GROUP="${SHEIN_BI_RUNTIME_GROUP:-sheinops}"
APPLY=0

usage() {
  cat <<'EOF'
Usage: bash scripts/harden_cloud_runtime_permissions.sh [--apply]

Without --apply this command is a read-only audit. With --apply it:
  1. pins the application root to sheinops:sheinops mode 0750;
  2. removes world-write from non-symlink files/directories on the same filesystem;
  3. leaves ownership and group-write bits below the root unchanged so mixed
     root/sheinops scheduled jobs keep working.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! -d "$ROOT" ]]; then
  echo "Application root does not exist: $ROOT" >&2
  exit 1
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'Audit and --apply must run as root so every runtime-owned subtree is inspected' >&2
  exit 1
fi

resolved_root="$(readlink -f -- "$ROOT")"
case "$resolved_root" in
  /opt/shein-bi/app|/srv/shein-bi/app) ;;
  *)
    if [[ "${SHEIN_BI_ALLOW_CUSTOM_ROOT:-0}" != "1" ]]; then
      echo "Refusing unexpected root: $resolved_root" >&2
      exit 1
    fi
    ;;
esac

id "$OWNER" >/dev/null
getent group "$GROUP" >/dev/null

count_world_writable() {
  find "$resolved_root" -xdev \( -type f -o -type d \) -perm -0002 -printf '.' | wc -c
}

before_count="$(count_world_writable)"
root_state="$(stat -c '%A %U:%G' "$resolved_root")"
printf 'mode=%s root=%s rootState=%s worldWritableNonSymlinks=%s\n' \
  "$([[ "$APPLY" == 1 ]] && echo apply || echo audit)" "$resolved_root" "$root_state" "$before_count"

if [[ "$APPLY" != 1 ]]; then
  find "$resolved_root" -xdev \( -type f -o -type d \) -perm -0002 -printf '%M %u:%g %p\n' | sed -n '1,50p'
  exit 0
fi

chown "$OWNER:$GROUP" "$resolved_root"
chmod 0750 "$resolved_root"
find "$resolved_root" -xdev \( -type f -o -type d \) -perm -0002 -exec chmod o-w -- {} +

after_count="$(count_world_writable)"
if [[ "$after_count" != 0 ]]; then
  echo "Permission hardening incomplete: $after_count world-writable entries remain" >&2
  exit 1
fi

printf 'ok=true rootState=%s worldWritableNonSymlinks=%s\n' \
  "$(stat -c '%A %U:%G' "$resolved_root")" "$after_count"
