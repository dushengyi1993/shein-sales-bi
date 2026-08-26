#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${INVENTORY_DEFAULT_LOCK_TEST_USERNS:-}" != 1 ]]; then
  exec unshare -Urm -- env INVENTORY_DEFAULT_LOCK_TEST_USERNS=1 "$0" "$@"
fi
mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /srv
mkdir -p /srv/shein-bi/runtime/locks
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
exec node "$ROOT/scripts/test_inventory_default_cutover_lock.mjs"
