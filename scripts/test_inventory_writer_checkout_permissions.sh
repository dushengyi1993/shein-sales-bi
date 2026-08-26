#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d /tmp/inventory-writer-permissions-XXXXXX)"
cleanup(){
  [[ "$TMP" == /tmp/inventory-writer-permissions-* && "$TMP" != /tmp ]] || return 70
  sudo rm -rf -- "$TMP"
}
trap cleanup EXIT
APP="$TMP/app"; RECEIPT="$TMP/source-permissions.receipt.json"
mkdir -p "$APP"
git -C "$APP" init -q
git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-permission-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$APP/.gitignore"
printf 'old\n' >"$APP/tracked.txt"
git -C "$APP" add .gitignore tracked.txt
git -C "$APP" commit -qm old
OLD="$(git -C "$APP" rev-parse HEAD)"
printf 'new\n' >"$APP/tracked.txt"
git -C "$APP" commit -qam new
NEW="$(git -C "$APP" rev-parse HEAD)"
mkdir -p "$APP/state" "$APP/tmp" "$APP/outputs" "$APP/profiles" "$APP/node_modules"

SERVICE_UID="$(id -u)"; SERVICE_GID="$(id -g)"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" \
  --apply --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" | grep -q '"ok":true'

set +e
git -c safe.directory="$APP" -C "$APP" checkout -q --detach "$OLD" >/dev/null 2>&1
CHECKOUT_CODE=$?
{ printf 'mutated\n' >"$APP/tracked.txt"; } 2>/dev/null
TRACKED_WRITE_CODE=$?
printf 'replacement\n' >"$TMP/replacement.txt"
mv -f "$TMP/replacement.txt" "$APP/tracked.txt" >/dev/null 2>&1
TRACKED_REPLACE_CODE=$?
set -e
[[ "$CHECKOUT_CODE" != 0 && "$TRACKED_WRITE_CODE" != 0 && "$TRACKED_REPLACE_CODE" != 0 ]]
[[ "$(git -c safe.directory="$APP" -C "$APP" rev-parse HEAD)" == "$NEW" && "$(cat "$APP/tracked.txt")" == new ]]

for runtime in state tmp outputs profiles node_modules; do
  mkdir "$APP/$runtime/service-$SERVICE_UID"
  printf 'ok\n' >"$APP/$runtime/service-$SERVICE_UID/write.txt"
done

RECEIPT_SHA="$(sudo sha256sum "$RECEIPT" | awk '{print $1}')"
set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" --rollback \
  --expected-receipt-sha256 "$(printf 'f%.0s' {1..64})" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
WRONG_ROLLBACK_CODE=$?
set -e
[[ "$WRONG_ROLLBACK_CODE" != 0 ]]
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" --rollback \
  --expected-receipt-sha256 "$RECEIPT_SHA" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
[[ "$(stat -c %u:%g:%a "$APP")" == "$SERVICE_UID:$SERVICE_GID:755" ]]

printf '{"ok":true,"checks":["real_service_user_git_checkout_denied","real_service_user_tracked_write_denied","real_service_user_tracked_replace_denied","five_runtime_allowlist_roots_writable","rollback_requires_exact_receipt_file_sha","exact_rollback_restores_original_permissions"]}\n'
