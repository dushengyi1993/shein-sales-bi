#!/usr/bin/env bash

# Prepare a lock shared by root-run and sheinops-run production jobs without
# exposing a world-writable file or relying on a predictable path in /tmp.
prepare_shared_lock_file() {
  if [[ "$#" -ne 1 || -z "${1:-}" ]]; then
    echo "prepare_shared_lock_file requires one lock path" >&2
    return 64
  fi

  local file="$1"
  local dir
  local shared_group="${SHEIN_BI_SHARED_LOCK_GROUP:-sheinops}"
  local current_group
  local mode
  dir="$(dirname -- "$file")"

  mkdir -p -- "$dir"
  if [[ -L "$dir" || ! -d "$dir" ]]; then
    echo "Refusing unsafe shared lock directory: $dir" >&2
    return 73
  fi

  if command -v getent >/dev/null 2>&1 && getent group "$shared_group" >/dev/null 2>&1; then
    current_group="$(stat -c '%G' -- "$dir")"
    if [[ "$current_group" != "$shared_group" ]] && ! chgrp "$shared_group" "$dir"; then
      echo "Cannot set shared lock directory group to $shared_group: $dir" >&2
      return 73
    fi
  fi
  chmod 2770 "$dir" 2>/dev/null || true
  mode="$(stat -c '%a' -- "$dir")"
  if [[ "$mode" != "2770" ]]; then
    echo "Shared lock directory must be mode 2770, got $mode: $dir" >&2
    return 73
  fi

  if [[ -L "$file" || ( -e "$file" && ! -f "$file" ) ]]; then
    echo "Refusing unsafe shared lock file: $file" >&2
    return 73
  fi
  (umask 007; touch -- "$file")
  if [[ -L "$file" || ! -f "$file" ]]; then
    echo "Shared lock path did not resolve to a regular file: $file" >&2
    return 73
  fi

  if command -v getent >/dev/null 2>&1 && getent group "$shared_group" >/dev/null 2>&1; then
    current_group="$(stat -c '%G' -- "$file")"
    if [[ "$current_group" != "$shared_group" ]] && ! chgrp "$shared_group" "$file"; then
      echo "Cannot set shared lock file group to $shared_group: $file" >&2
      return 73
    fi
  fi
  chmod 0660 "$file" 2>/dev/null || true
  mode="$(stat -c '%a' -- "$file")"
  if [[ "$mode" != "660" || ! -r "$file" || ! -w "$file" ]]; then
    echo "Shared lock file must be readable/writable with mode 660, got $mode: $file" >&2
    return 73
  fi
}
