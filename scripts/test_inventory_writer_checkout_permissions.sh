#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d /tmp/inventory-writer-permissions-XXXXXX)"
SAFE_PARENT="$(mktemp -d /tmp/inventory-writer-safe-XXXXXX)"
sudo chown 0:0 "$SAFE_PARENT"
sudo chmod 0755 "$SAFE_PARENT"
cleanup(){
  [[ "$TMP" == /tmp/inventory-writer-permissions-* && "$TMP" != /tmp ]] || return 70
  if [[ "${MOUNTED_STATE:-0}" == 1 ]]; then sudo umount "$RO_APP/state" >/dev/null 2>&1 || true; fi
  if [[ "${MOUNTED_PROFILES:-0}" == 1 ]]; then sudo umount "$RO_APP/profiles" >/dev/null 2>&1 || true; fi
  sudo rm -rf -- "$TMP"
  sudo rm -rf -- "$SAFE_PARENT"
}
trap cleanup EXIT
SERVICE_UID="$(id -u)"; SERVICE_GID="$(id -g)"
APP="$SAFE_PARENT/app"; RECEIPT="$TMP/source-permissions.receipt.json"
MAIN_PLAN="$TMP/source-permissions.plan.json"
MAIN_COMPLETION="$TMP/source-permissions.completion.json"
sudo install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0755 "$APP"
git -C "$APP" init -q
git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-permission-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$APP/.gitignore"
printf 'old\n' >"$APP/tracked.txt"
mkdir -p "$APP/outputs"
printf 'tracked output\n' >"$APP/outputs/tracked-output.txt"
git -C "$APP" add .gitignore tracked.txt
git -C "$APP" add -f outputs/tracked-output.txt
git -C "$APP" commit -qm old
OLD="$(git -C "$APP" rev-parse HEAD)"
printf 'new\n' >"$APP/tracked.txt"
git -C "$APP" commit -qam new
NEW="$(git -C "$APP" rev-parse HEAD)"
mkdir -p "$APP/state" "$APP/tmp" "$APP/outputs" "$APP/profiles" "$APP/node_modules"
sudo chown -R 0:0 "$APP"
MAIN_PREFLIGHT="$TMP/audit-main-preflight.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" \
  --generation-id test-main-v1 --plan-file "$MAIN_PLAN" \
  --completion-attestation "$MAIN_COMPLETION" >"$MAIN_PREFLIGHT"
MAIN_PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planSha256"])' <"$MAIN_PREFLIGHT")"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" \
  --generation-id test-main-v1 --plan-file "$MAIN_PLAN" \
  --completion-attestation "$MAIN_COMPLETION" \
  --expected-recovery-plan-sha256 "$MAIN_PLAN_SHA" \
  --apply --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
AUDIT_JSON="$TMP/audit-main.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group "$SERVICE_GID" --receipt "$RECEIPT" \
  --plan-file "$MAIN_PLAN" --completion-attestation "$MAIN_COMPLETION" >"$AUDIT_JSON"
grep -q '"ok":true' "$AUDIT_JSON"
AUDIT_JSON="$AUDIT_JSON" APP="$APP" python3 - <<'PY'
import json, os
value = json.load(open(os.environ["AUDIT_JSON"], encoding="utf-8"))
output = os.path.join(os.environ["APP"], "outputs", "tracked-output.txt")
assert value["managedSource"]["pathCount"] >= 1
assert value["managedRuntime"]["pathCount"] == 5
assert not value["externalRuntimeMounts"]
assert output.endswith("outputs/tracked-output.txt")
assert value["state"] == "audit_current_generation"
assert value["generationRelation"] == "current_scope_matches_completed_generation"
assert value["mutationAuthorized"] is False
PY

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
for runtime in state tmp outputs profiles node_modules; do
  rm -rf -- "$APP/$runtime/service-$SERVICE_UID"
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
  --expected-recovery-plan-sha256 "$MAIN_PLAN_SHA" \
  --plan-file "$MAIN_PLAN" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
[[ "$(stat -c %u:%g:%a "$APP")" == '0:0:755' ]]

RO_APP="$SAFE_PARENT/ro-app"; RO_SOURCE="$TMP/ro-source"; RO_RECEIPT="$TMP/ro-source-permissions.receipt.json"
RO_PLAN="$TMP/ro-source-permissions.plan.json"; RO_COMPLETION="$TMP/ro-source-permissions.completion.json"
sudo install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0755 "$RO_APP"
mkdir -p "$RO_SOURCE/state" "$RO_SOURCE/profiles"
git -C "$RO_APP" init -q
git -C "$RO_APP" config user.email test@example.invalid
git -C "$RO_APP" config user.name inventory-permission-recovery-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$RO_APP/.gitignore"
printf 'recovery\n' >"$RO_APP/tracked.txt"
git -C "$RO_APP" add .gitignore tracked.txt
git -C "$RO_APP" commit -qm recovery
mkdir -p "$RO_APP/state" "$RO_APP/tmp" "$RO_APP/outputs" "$RO_APP/profiles" "$RO_APP/node_modules"
sudo chown -R 0:0 "$RO_APP"
printf 'state sentinel\n' >"$RO_SOURCE/state/sentinel.txt"
printf 'profiles sentinel\n' >"$RO_SOURCE/profiles/sentinel.txt"
MOUNTED_STATE=0; MOUNTED_PROFILES=0; RO_BIND_MOUNT=0
if sudo mount --bind "$RO_SOURCE/state" "$RO_APP/state" >/dev/null 2>&1; then
  MOUNTED_STATE=1
  if ! sudo mount -o remount,bind,ro "$RO_APP/state" >/dev/null 2>&1; then
    sudo umount "$RO_APP/state" >/dev/null 2>&1 || true
    MOUNTED_STATE=0
  fi
fi
if [[ "$MOUNTED_STATE" == 1 ]] && sudo mount --bind "$RO_SOURCE/profiles" "$RO_APP/profiles" >/dev/null 2>&1; then
  MOUNTED_PROFILES=1
  if ! sudo mount -o remount,bind,ro "$RO_APP/profiles" >/dev/null 2>&1; then
    sudo umount "$RO_APP/profiles" >/dev/null 2>&1 || true
    MOUNTED_PROFILES=0
  fi
fi
if [[ "$MOUNTED_STATE" == 1 && "$MOUNTED_PROFILES" == 1 ]]; then
  RO_BIND_MOUNT=1
else
  if [[ "$MOUNTED_STATE" == 1 ]]; then sudo umount "$RO_APP/state" >/dev/null 2>&1 || true; fi
  if [[ "$MOUNTED_PROFILES" == 1 ]]; then sudo umount "$RO_APP/profiles" >/dev/null 2>&1 || true; fi
  MOUNTED_STATE=0; MOUNTED_PROFILES=0
  sudo chmod 0555 "$RO_APP/state" "$RO_APP/profiles"
fi

APP="$RO_APP" RECEIPT="$RO_RECEIPT" SERVICE_GID="$SERVICE_GID" ROOT="$ROOT" python3 - <<'PY'
import importlib.util, os
app = os.environ["APP"]
receipt_file = os.environ["RECEIPT"]
gid = int(os.environ["SERVICE_GID"])
script = os.path.join(os.environ["ROOT"], "scripts", "harden_inventory_writer_checkout_permissions.py")
spec = importlib.util.spec_from_file_location("inventory_hardener", script)
hardener = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardener)
scope = hardener.build_scope(app)
legacy_paths = sorted(set(scope["managedPaths"] + [os.path.join(app, name) for name in hardener.ALLOWLIST]))
before = [hardener.metadata_row(row) for row in hardener.snapshot_paths(legacy_paths)]
core = {
    "schemaVersion": hardener.SCHEMA,
    "kind": "inventory_writer_checkout_permissions",
    "appRoot": app,
    "serviceGroup": str(gid),
    "serviceGid": gid,
    "before": before,
    "beforeManifestSha256": hardener.digest(before),
    "recordedAt": "2026-08-27T00:00:00.000Z",
}
value = {**core, "receiptHash": hardener.digest(core)}
with open(receipt_file, "wb") as stream:
    stream.write(hardener.canonical(value) + b"\n")
PY
RO_RECEIPT_SHA="$(sha256sum "$RO_RECEIPT" | awk '{print $1}')"
RO_STATE_SENTINEL_SHA="$(sha256sum "$RO_APP/state/sentinel.txt" | awk '{print $1}')"
RO_PROFILES_SENTINEL_SHA="$(sha256sum "$RO_APP/profiles/sentinel.txt" | awk '{print $1}')"
RO_STATE_SENTINEL_STAT="$(stat -c '%u:%g:%a:%s' "$RO_APP/state/sentinel.txt")"
RO_PROFILES_SENTINEL_STAT="$(stat -c '%u:%g:%a:%s' "$RO_APP/profiles/sentinel.txt")"
sudo chown 0:"$SERVICE_GID" "$RO_APP/tracked.txt"
RO_AUDIT="$TMP/ro-audit.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" >"$RO_AUDIT"
grep -q '"recoveryRequired":true' "$RO_AUDIT"
RO_PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planSha256"])' <"$RO_AUDIT")"
sudo env RO_BIND_MOUNT="$RO_BIND_MOUNT" RO_AUDIT="$RO_AUDIT" RO_APP="$RO_APP" \
  RO_RECEIPT="$RO_RECEIPT" RO_PLAN="$RO_PLAN" python3 - <<'PY'
import json, os
value = json.load(open(os.environ["RO_AUDIT"], encoding="utf-8"))
receipt = json.load(open(os.environ["RO_RECEIPT"], encoding="utf-8"))
plan = json.load(open(os.environ["RO_PLAN"], encoding="utf-8"))
metadata_keys = {"path", "type", "uid", "gid", "mode"}
identity_keys = metadata_keys | {"st_dev", "st_ino", "st_nlink"}
assert all(set(row) == metadata_keys for row in receipt["before"])
assert plan["schemaVersion"].endswith("/v2")
assert plan["planHash"] == value["planSha256"]
assert all(set(row) == identity_keys for row in plan["managedBefore"])
assert all(row["st_nlink"] == 1 for row in plan["managedBefore"] if row["type"] == "file")
assert all(row["st_dev"] > 0 and row["st_ino"] > 0
           for row in plan["managedBefore"] if row["type"] == "directory")
for row in value["externalRuntimeMounts"]:
    assert set(row) == {"mountId", "mountpoint", "root", "majorMinor", "roRw"}
    assert isinstance(row["mountId"], int) and row["mountId"] > 0
    assert row["mountpoint"].startswith(os.sep) and row["root"].startswith(os.sep)
    assert ":" in row["majorMinor"] and row["roRw"] in ("ro", "rw")
if os.environ["RO_BIND_MOUNT"] == "1":
    mountpoints = {row["mountpoint"] for row in value["externalRuntimeMounts"]}
    assert os.path.join(os.environ["RO_APP"], "state") in mountpoints
    assert os.path.join(os.environ["RO_APP"], "profiles") in mountpoints
PY
RO_APPLY_ONE="$TMP/ro-apply-one.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$RO_RECEIPT_SHA" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >"$RO_APPLY_ONE"
grep -q '"state":"hardened"' "$RO_APPLY_ONE"
[[ "$(sha256sum "$RO_RECEIPT" | awk '{print $1}')" == "$RO_RECEIPT_SHA" ]]
[[ "$(sha256sum "$RO_APP/state/sentinel.txt" | awk '{print $1}')" == "$RO_STATE_SENTINEL_SHA" ]]
[[ "$(sha256sum "$RO_APP/profiles/sentinel.txt" | awk '{print $1}')" == "$RO_PROFILES_SENTINEL_SHA" ]]
[[ "$(stat -c '%u:%g:%a:%s' "$RO_APP/state/sentinel.txt")" == "$RO_STATE_SENTINEL_STAT" ]]
[[ "$(stat -c '%u:%g:%a:%s' "$RO_APP/profiles/sentinel.txt")" == "$RO_PROFILES_SENTINEL_STAT" ]]
RO_APPLY_TWO="$TMP/ro-apply-two.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$RO_RECEIPT_SHA" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >"$RO_APPLY_TWO"
grep -q '"state":"already_hardened"' "$RO_APPLY_TWO"

RO_COMPLETION_SHA="$(sudo sha256sum "$RO_COMPLETION" | awk '{print $1}')"

RO_TARGET_STAT="$(stat -c '%u:%g:%a:%s' "$RO_APP/tracked.txt")"
set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$(printf 'f%.0s' {1..64})" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
WRONG_RECEIPT_CODE=$?
set -e
[[ "$WRONG_RECEIPT_CODE" != 0 && "$(stat -c '%u:%g:%a:%s' "$RO_APP/tracked.txt")" == "$RO_TARGET_STAT" ]]
set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$RO_RECEIPT_SHA" --expected-recovery-plan-sha256 "$(printf 'f%.0s' {1..64})" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
WRONG_PLAN_CODE=$?
set -e
[[ "$WRONG_PLAN_CODE" != 0 && "$(stat -c '%u:%g:%a:%s' "$RO_APP/tracked.txt")" == "$RO_TARGET_STAT" ]]

BAD_RECEIPT="$TMP/bad-source-permissions.receipt.json"
RO_RECEIPT="$RO_RECEIPT" BAD_RECEIPT="$BAD_RECEIPT" python3 - <<'PY'
import hashlib, json, os
def enc(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
def sha(value):
    return hashlib.sha256(enc(value)).hexdigest()
value = json.load(open(os.environ["RO_RECEIPT"], encoding="utf-8"))
value["before"][0]["path"] = os.path.join(os.path.dirname(os.environ["BAD_RECEIPT"]), "outside-receipt-path")
value["beforeManifestSha256"] = sha(value["before"])
core = dict(value); core.pop("receiptHash")
value["receiptHash"] = sha(core)
open(os.environ["BAD_RECEIPT"], "wb").write(enc(value) + b"\n")
PY
BAD_RECEIPT_SHA="$(sha256sum "$BAD_RECEIPT" | awk '{print $1}')"
set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$BAD_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$BAD_RECEIPT_SHA" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
BAD_PATH_CODE=$?
set -e
[[ "$BAD_PATH_CODE" != 0 && "$(stat -c '%u:%g:%a:%s' "$RO_APP/tracked.txt")" == "$RO_TARGET_STAT" ]]

# A completed legacy generation remains immutable evidence after an exact
# root-only deployment adds tracked and .git paths. Current audit is dynamic,
# while the old receipt cannot mutate or roll back the expanded scope.
printf 'generation two\n' >"$TMP/generation-two.txt"
sudo install -o 0 -g 0 -m 0644 "$TMP/generation-two.txt" "$RO_APP/generation-two.txt"
sudo git -c safe.directory="$RO_APP" -C "$RO_APP" add generation-two.txt
sudo git -c safe.directory="$RO_APP" -C "$RO_APP" \
  -c user.email=test@example.invalid -c user.name=inventory-permission-generation-test \
  commit -qm generation-two
GENERATION_TWO_COMMIT="$(sudo git -c safe.directory="$RO_APP" -C "$RO_APP" rev-parse HEAD)"
GENERATION_TWO_STAT="$(stat -c '%u:%g:%a:%s' "$RO_APP/generation-two.txt")"
RO_GENERATION_AUDIT="$TMP/ro-generation-audit.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" >"$RO_GENERATION_AUDIT"
RO_GENERATION_AUDIT="$RO_GENERATION_AUDIT" GENERATION_TWO_COMMIT="$GENERATION_TWO_COMMIT" python3 - <<'PY'
import json, os
value = json.load(open(os.environ["RO_GENERATION_AUDIT"], encoding="utf-8"))
assert value["ok"] is True
assert value["state"] == "audit_current_generation"
assert value["mutationAuthorized"] is False
assert value["recoveryRequired"] is False
assert value["generationRelation"] == "historical_completion_current_scope_advanced"
assert value["currentGeneration"]["headCommit"] == os.environ["GENERATION_TWO_COMMIT"]
assert value["currentGeneration"]["managedSourcePathCount"] > value["historicalCompletion"]["managedPathCount"]
assert value["historicalCompletion"]["sourceGeneration"]["headCommit"] != os.environ["GENERATION_TWO_COMMIT"]
PY
[[ "$(sha256sum "$RO_RECEIPT" | awk '{print $1}')" == "$RO_RECEIPT_SHA" ]]
[[ "$(sudo sha256sum "$RO_COMPLETION" | awk '{print $1}')" == "$RO_COMPLETION_SHA" ]]

set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$RO_RECEIPT_SHA" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
OLD_REHARDEN_CODE=$?
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --rollback --expected-receipt-sha256 "$RO_RECEIPT_SHA" \
  --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
OLD_GENERATION_ROLLBACK_CODE=$?
set -e
[[ "$OLD_REHARDEN_CODE" != 0 && "$OLD_GENERATION_ROLLBACK_CODE" != 0 ]]
[[ "$(stat -c '%u:%g:%a:%s' "$RO_APP/generation-two.txt")" == "$GENERATION_TWO_STAT" ]]
[[ "$(sha256sum "$RO_RECEIPT" | awk '{print $1}')" == "$RO_RECEIPT_SHA" ]]
[[ "$(sudo sha256sum "$RO_COMPLETION" | awk '{print $1}')" == "$RO_COMPLETION_SHA" ]]

GEN2_RECEIPT="$TMP/source-permissions-generation-two.receipt.json"
GEN2_PLAN="$TMP/source-permissions-generation-two.plan.json"
GEN2_COMPLETION="$TMP/source-permissions-generation-two.completion.json"
GEN2_PREFLIGHT="$TMP/source-permissions-generation-two.preflight.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$GEN2_RECEIPT" \
  --generation-id test-generation-two --plan-file "$GEN2_PLAN" \
  --completion-attestation "$GEN2_COMPLETION" >"$GEN2_PREFLIGHT"
GEN2_PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planSha256"])' <"$GEN2_PREFLIGHT")"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$GEN2_RECEIPT" \
  --generation-id test-generation-two --plan-file "$GEN2_PLAN" \
  --completion-attestation "$GEN2_COMPLETION" --apply \
  --expected-recovery-plan-sha256 "$GEN2_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
GEN2_RECEIPT_SHA="$(sudo sha256sum "$GEN2_RECEIPT" | awk '{print $1}')"
GEN2_AUDIT="$TMP/source-permissions-generation-two.audit.json"
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$GEN2_RECEIPT" \
  --plan-file "$GEN2_PLAN" --completion-attestation "$GEN2_COMPLETION" >"$GEN2_AUDIT"
grep -q '"generationRelation":"current_scope_matches_completed_generation"' "$GEN2_AUDIT"
[[ -s "$GEN2_RECEIPT" && -s "$GEN2_PLAN" && -s "$GEN2_COMPLETION" ]]
[[ "$GEN2_RECEIPT_SHA" != "$RO_RECEIPT_SHA" ]]
[[ "$(sha256sum "$RO_RECEIPT" | awk '{print $1}')" == "$RO_RECEIPT_SHA" ]]
[[ "$(sudo sha256sum "$RO_COMPLETION" | awk '{print $1}')" == "$RO_COMPLETION_SHA" ]]

if [[ "$RO_BIND_MOUNT" == 1 ]]; then
  sudo umount "$RO_APP/state"
  MOUNTED_STATE=0
else
  sudo chmod 0755 "$RO_APP/state"
fi
set +e
sudo python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$RO_APP" --service-group "$SERVICE_GID" --receipt "$RO_RECEIPT" \
  --plan-file "$RO_PLAN" --completion-attestation "$RO_COMPLETION" --apply \
  --expected-receipt-sha256 "$RO_RECEIPT_SHA" --expected-recovery-plan-sha256 "$RO_PLAN_SHA" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
MOUNT_DRIFT_CODE=$?
set -e
[[ "$MOUNT_DRIFT_CODE" != 0 && "$(stat -c '%u:%g:%a:%s' "$RO_APP/tracked.txt")" == "$RO_TARGET_STAT" ]]

IDENTITY_RACE_ROOT="$SAFE_PARENT/identity-races"
sudo env ROOT="$ROOT" IDENTITY_RACE_ROOT="$IDENTITY_RACE_ROOT" SERVICE_UID="$SERVICE_UID" SERVICE_GID="$SERVICE_GID" \
  python3 - <<'PY'
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys

script = os.path.join(os.environ["ROOT"], "scripts", "harden_inventory_writer_checkout_permissions.py")
root = os.environ["IDENTITY_RACE_ROOT"]
gid = int(os.environ["SERVICE_GID"])
service_uid = int(os.environ["SERVICE_UID"])
spec = importlib.util.spec_from_file_location("inventory_hardener_parent_race", script)
hardener = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardener)
app = os.path.join(root, "app")
receipt = os.path.join(root, "permissions.receipt.json")
plan = os.path.join(root, "permissions.plan.json")
completion = os.path.join(root, "permissions.completion.json")
target = os.path.join(app, "race-target.txt")
os.makedirs(app)
os.chown(app, 0, gid)
os.chmod(app, 0o770)

def command(*arguments, expected=0):
    result = subprocess.run(
        [sys.executable, script, *arguments], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False,
    )
    if expected == 0:
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
    else:
        assert result.returncode != 0, (result.returncode, result.stdout, result.stderr)
        assert "identity drift" in result.stderr or "link count" in result.stderr, result.stderr
    return result

def git(*arguments):
    result = subprocess.run(
        ["git", "-c", f"safe.directory={app}", "-C", app, *arguments],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, check=False,
    )
    assert result.returncode == 0, (arguments, result.stderr)
    return result.stdout.strip()

def permission_state_from_info(info):
    return info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)

def permission_state(path):
    return permission_state_from_info(os.stat(path))

git("init", "-q")
git("config", "user.email", "identity-race@example.invalid")
git("config", "user.name", "inventory-identity-race")
with open(os.path.join(app, ".gitignore"), "w", encoding="utf-8") as stream:
    stream.write("state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n")
with open(target, "w", encoding="utf-8") as stream:
    stream.write("identity race target\n")
bulk_paths = []
for index in range(300):
    relative = f"bulk-{index:03d}.txt"
    with open(os.path.join(app, relative), "w", encoding="utf-8") as stream:
        stream.write(f"bulk target {index}\n")
    bulk_paths.append(relative)
git("add", ".gitignore", "race-target.txt", *bulk_paths)
git("commit", "-qm", "identity-race-base")
for name in ("state", "tmp", "outputs", "profiles", "node_modules"):
    os.makedirs(os.path.join(app, name))

base = [
    "--app-root", app, "--service-group", str(gid), "--receipt", receipt,
    "--generation-id", "identity-race-v1", "--plan-file", plan,
    "--completion-attestation", completion,
]
preflight = command(*base)
plan_hash = json.loads(preflight.stdout)["planSha256"]
plan_value = json.load(open(plan, encoding="utf-8"))
assert plan_value["schemaVersion"].endswith("/v2")
assert plan_value["planHash"] == plan_hash
assert all(set(row) == {"path", "type", "uid", "gid", "mode", "st_dev", "st_ino", "st_nlink"}
           for row in plan_value["managedBefore"])
target_row = next(row for row in plan_value["managedBefore"] if row["path"] == target)
app_row = next(row for row in plan_value["managedBefore"] if row["path"] == app)
assert target_row["type"] == "file" and target_row["st_nlink"] == 1
assert app_row["type"] == "directory" and app_row["st_dev"] > 0 and app_row["st_ino"] > 0
plan_states = {row["path"]: (row["uid"], row["gid"], row["mode"])
               for row in plan_value["managedBefore"]}
scope = hardener.build_scope(app)
race_rows = plan_value["managedBefore"]
assert [row["path"] for row in race_rows] == sorted(scope["managedPaths"])
assert sum(
    (row["uid"], row["gid"], row["mode"])
    != hardener.desired_permission_state(app, gid, row, "apply")
    for row in race_rows
) > hardener.RECOVERY_FD_SHARD_SIZE
original_bytes = open(target, "rb").read()
original_state = permission_state(target)

def assert_other_states(expected):
    for path, state_value in expected.items():
        if path != target:
            assert permission_state(path) == state_value, path

def moved_path(moved_parent, path):
    return os.path.join(moved_parent, os.path.relpath(path, os.path.dirname(app)))

def restore_replaced_parent(moved_parent, victim):
    os.unlink(victim)
    os.rmdir(os.path.dirname(victim))
    os.rmdir(os.path.dirname(app))
    os.rename(moved_parent, os.path.dirname(app))

def replace_parent_with_victim(operation, victim_state):
    parent = os.path.dirname(app)
    moved_parent = parent + ".moved-" + operation
    os.rename(parent, moved_parent)
    os.mkdir(parent, 0o755)
    replacement_app = os.path.join(parent, "app")
    os.mkdir(replacement_app, 0o755)
    victim = os.path.join(replacement_app, os.path.basename(target))
    with open(victim, "wb") as stream:
        stream.write(b"replacement directory victim\n")
    os.chown(victim, victim_state[0], victim_state[1])
    os.chmod(victim, victim_state[2])
    return moved_parent, victim

def assert_moved_states(moved_parent, expected):
    for path, state_value in expected.items():
        assert permission_state(moved_path(moved_parent, path)) == state_value, path

def run_parent_replacement(operation, mutate, expected_after, victim_state):
    hook_state = {"done": False, "moved": None, "victim": None}
    def hook(path, descriptor, current_operation):
        if path != target or hook_state["done"]:
            return
        assert current_operation == operation
        hook_state["done"] = True
        hook_state["moved"], hook_state["victim"] = replace_parent_with_victim(
            operation, victim_state)
    hardener.before_permission_write = hook
    try:
        try:
            mutate()
        except RuntimeError as error:
            assert "partial failure recovered on exact inodes" in str(error), str(error)
            assert "permission path identity" in str(error) or "external parent" in str(error), str(error)
        else:
            raise AssertionError(f"{operation} parent replacement returned success")
    finally:
        hardener.before_permission_write = lambda target, descriptor, operation: None
    assert hook_state["done"] is True
    assert permission_state(hook_state["victim"]) == victim_state
    assert_moved_states(hook_state["moved"], expected_after)
    restore_replaced_parent(hook_state["moved"], hook_state["victim"])

def assert_nonroot_rename_blocked(path):
    parked_path = path + ".nonroot-rename"
    child = os.fork()
    if child == 0:
        try:
            os.setgroups([])
            os.setgid(gid)
            os.setuid(service_uid)
            os.rename(path, parked_path)
        except PermissionError:
            os._exit(0)
        except OSError:
            os._exit(2)
        os._exit(1)
    _, status = os.waitpid(child, 0)
    assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, status
    assert not os.path.exists(parked_path)

original_states = dict(plan_states)

# The parent directory is replaced after the leaf fd has been identity-checked.
# The original tree is moved outside the checkout and a replacement victim is
# installed at the old pathname.  The transaction must fail closed, recover
# through the already-held fds, and leave both trees unchanged.
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "apply")
run_parent_replacement(
    "apply",
    lambda: hardener.apply_permissions(app, gid, race_rows, scope, validated),
    original_states,
    (0, gid, 0o601),
)

# With the in-tree root locked, the actual service uid cannot rename the leaf.
# This is the non-root invariant used between the path/fd check and the first
# metadata syscall.  The same hook is exercised during rollback while the
# parent is still locked.
def nonroot_hook(path, descriptor, operation):
    if path == target:
        assert permission_state(app) == (0, gid, 0o750), (operation, permission_state(app))
        assert_nonroot_rename_blocked(path)

hardener.before_permission_write = nonroot_hook
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "apply")
hardener.apply_permissions(app, gid, race_rows, scope, validated)
hardener.before_permission_write = lambda target, descriptor, operation: None
original_states_after_apply = {
    row["path"]: permission_state(row["path"]) for row in race_rows
}
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "rollback")
hardener.restore_permissions(app, gid, race_rows, scope, validated)
assert {
    row["path"]: permission_state(row["path"]) for row in race_rows
} == original_states

apply_arguments = [
    *base, "--expected-recovery-plan-sha256", plan_hash,
    "--apply", "--confirm", "HARDEN_INVENTORY_WRITER_CHECKOUT_V1",
]

# Real CLI apply: ordinary replacement with identical content and metadata.
parked = os.path.join(root, "parked-original.txt")
ordinary = os.path.join(root, "apply-ordinary-victim.txt")
with open(ordinary, "wb") as stream:
    stream.write(original_bytes)
os.chown(ordinary, target_row["uid"], target_row["gid"])
os.chmod(ordinary, target_row["mode"])
ordinary_fd = os.open(ordinary, os.O_RDONLY)
ordinary_before = permission_state_from_info(os.fstat(ordinary_fd))
os.rename(target, parked)
os.rename(ordinary, target)
command(*apply_arguments, expected=1)
assert permission_state_from_info(os.fstat(ordinary_fd)) == ordinary_before
assert permission_state(parked) == original_state
assert_other_states(plan_states)
assert not os.path.exists(receipt) and not os.path.exists(completion)
os.close(ordinary_fd)
os.unlink(target)
os.rename(parked, target)

# Real CLI apply: hard-link replacement to an app-external victim.
hard_victim = os.path.join(root, "apply-hardlink-victim.txt")
with open(hard_victim, "wb") as stream:
    stream.write(original_bytes)
os.chown(hard_victim, target_row["uid"], target_row["gid"])
os.chmod(hard_victim, target_row["mode"])
os.rename(target, parked)
os.link(hard_victim, target)
hard_before = permission_state(hard_victim)
command(*apply_arguments, expected=1)
assert permission_state(hard_victim) == hard_before
assert permission_state(parked) == original_state
assert_other_states(plan_states)
assert not os.path.exists(receipt) and not os.path.exists(completion)
os.unlink(target)
os.rename(parked, target)

# Establish the real hardened state before rollback replacement tests.
command(*apply_arguments)
receipt_sha = hashlib.sha256(open(receipt, "rb").read()).hexdigest()
hardened_state = permission_state(target)
hardened_states = {row["path"]: permission_state(row["path"])
                   for row in plan_value["managedBefore"]}

validated = hardener.validate_current_rows(race_rows, app, gid, scope, "rollback")
run_parent_replacement(
    "rollback",
    lambda: hardener.restore_permissions(app, gid, race_rows, scope, validated),
    original_states_after_apply,
    (0, gid, 0o602),
)

hardener.before_permission_write = nonroot_hook
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "rollback")
hardener.restore_permissions(app, gid, race_rows, scope, validated)
hardener.before_permission_write = lambda target, descriptor, operation: None
assert {
    row["path"]: permission_state(row["path"]) for row in race_rows
} == original_states
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "apply")
hardener.apply_permissions(app, gid, race_rows, scope, validated)
assert {
    row["path"]: permission_state(row["path"]) for row in race_rows
} == hardened_states

rollback_arguments = [
    "--app-root", app, "--service-group", str(gid), "--receipt", receipt,
    "--plan-file", plan, "--completion-attestation", completion,
    "--expected-receipt-sha256", receipt_sha,
    "--expected-recovery-plan-sha256", plan_hash,
    "--rollback", "--confirm", "ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1",
]

# Real CLI rollback: ordinary replacement with legal hardened metadata.
ordinary = os.path.join(root, "rollback-ordinary-victim.txt")
with open(ordinary, "wb") as stream:
    stream.write(original_bytes)
os.chown(ordinary, hardened_state[0], hardened_state[1])
os.chmod(ordinary, hardened_state[2])
ordinary_fd = os.open(ordinary, os.O_RDONLY)
ordinary_before = permission_state_from_info(os.fstat(ordinary_fd))
os.rename(target, parked)
os.rename(ordinary, target)
command(*rollback_arguments, expected=1)
assert permission_state_from_info(os.fstat(ordinary_fd)) == ordinary_before
assert permission_state(parked) == hardened_state
assert_other_states(hardened_states)
os.close(ordinary_fd)
os.unlink(target)
os.rename(parked, target)

# Real CLI rollback: hard-link replacement to an app-external victim.
hard_victim = os.path.join(root, "rollback-hardlink-victim.txt")
with open(hard_victim, "wb") as stream:
    stream.write(original_bytes)
os.chown(hard_victim, hardened_state[0], hardened_state[1])
os.chmod(hard_victim, hardened_state[2])
os.rename(target, parked)
os.link(hard_victim, target)
hard_before = permission_state(hard_victim)
command(*rollback_arguments, expected=1)
assert permission_state(hard_victim) == hard_before
assert permission_state(parked) == hardened_state
assert_other_states(hardened_states)
os.unlink(target)
os.rename(parked, target)

# Service-identity external parent policy regression.  A parent owned by a
# different non-root user with no group/world write is safe for the service
# writer, while a parent owned by the service writer itself (owner-write) is
# not.  An unresolved identity keeps the strict root-only fallback.
chain_root = os.path.join(root, "chain-policy")
os.makedirs(chain_root)
try:
    foreign = os.path.join(chain_root, "foreign"); os.mkdir(foreign, 0o755)
    os.chown(foreign, service_uid + 1, service_uid + 1)
    foreign_app = os.path.join(foreign, "app"); os.mkdir(foreign_app, 0o750)
    os.chown(foreign_app, 0, gid)
    hardener.validate_external_parent_chain(foreign_app, service_uid=service_uid)
    try:
        hardener.validate_external_parent_chain(foreign_app, service_uid=0)
        raise AssertionError("strict fallback accepted foreign parent")
    except RuntimeError as error:
        assert "root-owned" in str(error), str(error)

    service_parent = os.path.join(chain_root, "svc"); os.mkdir(service_parent, 0o755)
    os.chown(service_parent, service_uid, service_uid)
    service_app = os.path.join(service_parent, "app"); os.mkdir(service_app, 0o750)
    os.chown(service_app, 0, gid)
    try:
        hardener.validate_external_parent_chain(service_app, service_uid=service_uid)
        raise AssertionError("service-owned parent accepted")
    except RuntimeError as error:
        assert "permits service rename" in str(error), str(error)
finally:
    shutil.rmtree(chain_root, ignore_errors=True)
PY

RACE_APP="$SAFE_PARENT/race-app"; RACE_VICTIM="$TMP/race-victim.txt"
sudo install -d -o "$SERVICE_UID" -g "$SERVICE_GID" -m 0770 "$RACE_APP"
git -C "$RACE_APP" init -q
git -C "$RACE_APP" config user.email test@example.invalid
git -C "$RACE_APP" config user.name inventory-permission-race-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$RACE_APP/.gitignore"
printf 'race target\n' >"$RACE_APP/race-target.txt"
git -C "$RACE_APP" add .gitignore race-target.txt
git -C "$RACE_APP" commit -qm race-base
mkdir -p "$RACE_APP/state" "$RACE_APP/tmp" "$RACE_APP/outputs" "$RACE_APP/profiles" "$RACE_APP/node_modules"
printf 'outside victim\n' >"$RACE_VICTIM"
sudo env ROOT="$ROOT" RACE_APP="$RACE_APP" RACE_VICTIM="$RACE_VICTIM" SERVICE_GID="$SERVICE_GID" \
  python3 - <<'PY'
import importlib.util
import errno
import os
import stat

script = os.path.join(os.environ["ROOT"], "scripts", "harden_inventory_writer_checkout_permissions.py")
spec = importlib.util.spec_from_file_location("inventory_hardener_race", script)
hardener = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardener)
app = os.environ["RACE_APP"]
victim = os.environ["RACE_VICTIM"]
gid = int(os.environ["SERVICE_GID"])
target = os.path.join(app, "race-target.txt")
parked = target + ".parked"

def identity(path):
    info = os.stat(path)
    return info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)

victim_identity = identity(victim)
scope = hardener.build_scope(app)
all_before = hardener.snapshot_paths(scope["managedPaths"])
by_path = {row["path"]: row for row in all_before}
race_rows = all_before
target_row = by_path[target]

# Deterministic apply race hook: validation has completed, then the leaf is
# atomically replaced by an app-external symlink before mutation opens it.
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "apply")
os.rename(target, parked)
os.symlink(victim, target)
try:
    hardener.apply_permissions(app, gid, race_rows, scope, validated)
except RuntimeError as error:
    assert "partial failure recovered on exact inodes" in str(error)
    assert "Too many levels of symbolic links" in str(error)
else:
    raise AssertionError("apply swap race returned success")
assert identity(victim) == victim_identity
assert identity(parked) == (target_row["uid"], target_row["gid"], target_row["mode"])
for row in race_rows:
    if row["path"] != target:
        assert identity(row["path"]) == (row["uid"], row["gid"], row["mode"]), row["path"]

os.unlink(target)
os.rename(parked, target)
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "apply")
hardener.apply_permissions(app, gid, race_rows, scope, validated)

# Deterministic rollback race hook at the same post-preflight boundary.
validated = hardener.validate_current_rows(race_rows, app, gid, scope, "rollback")
os.rename(target, parked)
os.symlink(victim, target)
try:
    hardener.restore_permissions(app, gid, race_rows, scope, validated)
except RuntimeError as error:
    assert "partial failure recovered on exact inodes" in str(error)
    assert "Too many levels of symbolic links" in str(error)
else:
    raise AssertionError("rollback swap race returned success")
assert identity(victim) == victim_identity
desired = hardener.desired_mode_from_row(app, target_row)
assert identity(parked) == (0, gid, desired)
for row in race_rows:
    if row["path"] != target:
        expected = hardener.desired_mode_from_row(app, row)
        assert identity(row["path"]) == (0, gid, expected), row["path"]
PY

if [[ "$RO_BIND_MOUNT" == 1 ]]; then RO_RUNTIME_MODE=bind-ro; else RO_RUNTIME_MODE=mode-equivalent; fi
printf '{"ok":true,"roRuntimeMode":"%s","checks":["real_service_user_git_checkout_denied","real_service_user_tracked_write_denied","real_service_user_tracked_replace_denied","five_runtime_allowlist_roots_writable","tracked_outputs_remain_managed_source","rollback_requires_exact_receipt_file_sha_and_plan","exact_rollback_restores_original_permissions","old_v1_receipt_resume_without_rewrite","ro_runtime_sentinel_unchanged","already_hardened_resume","wrong_receipt_hash_zero_write","wrong_recovery_plan_hash_zero_write","wrong_path_zero_write","historical_completion_current_scope_audit","old_generation_cannot_reharden_or_rollback_new_paths","new_generation_distinct_artifacts_apply","mount_or_read_only_equivalent_drift_zero_write","apply_ordinary_replacement_real_cli_fail_closed","apply_hardlink_replacement_real_cli_fail_closed","rollback_ordinary_replacement_real_cli_fail_closed","rollback_hardlink_replacement_real_cli_fail_closed","apply_swap_race_fd_anchored_fail_closed","rollback_swap_race_fd_anchored_fail_closed","external_victim_permissions_unchanged","apply_parent_directory_replacement_fd_recovery","rollback_parent_directory_replacement_fd_recovery","nonroot_apply_rename_blocked_by_parent_lock","nonroot_rollback_rename_blocked_by_parent_lock"]}\n' "$RO_RUNTIME_MODE"
