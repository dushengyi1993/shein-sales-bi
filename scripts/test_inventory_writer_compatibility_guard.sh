#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

run_mount_namespace_reexec_tests(){
  ROOT="$ROOT" python3 - <<'PY'
import contextlib
import errno
import importlib.util
import io
import json
import os
import sys
from types import SimpleNamespace
from unittest import mock

script = os.path.join(os.environ["ROOT"], "infra", "inventory_writer_compatibility_guard.py")
spec = importlib.util.spec_from_file_location("inventory_compatibility_guard_namespace_test", script)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

assert guard.NSENTER_PATH == "/usr/bin/nsenter"
assert guard.SELF_MOUNT_NAMESPACE == "/proc/self/ns/mnt"
assert guard.HOST_MOUNT_NAMESPACE == "/proc/1/ns/mnt"

with mock.patch.object(guard.os, "stat", return_value=SimpleNamespace(st_dev=41, st_ino=73)) as stat_call:
    assert guard.mount_namespace_identity(guard.SELF_MOUNT_NAMESPACE) == (41, 73)
    stat_call.assert_called_once_with(guard.SELF_MOUNT_NAMESPACE)

with mock.patch.object(guard, "secure_parent_chain") as secure_parent, \
        mock.patch.object(guard, "secure_regular") as secure_file:
    guard.validate_nsenter_executable()
    secure_parent.assert_called_once_with("/usr/bin/nsenter", "nsenter executable", "/")
    secure_file.assert_called_once_with("/usr/bin/nsenter", "nsenter executable", executable=True)

original_argv = [
    "/secure/inventory-guard", "--unit", "shein-bi-portal.service",
    "--app-root", "/opt/shein-bi/app", "--activation-file", "/control/activation.ndjson",
]
same_identity = mock.Mock(return_value=(7, 11))
with mock.patch.object(guard, "mount_namespace_identity", same_identity), \
        mock.patch.object(guard, "validate_nsenter_executable") as nsenter_validation, \
        mock.patch.object(guard.subprocess, "run") as runner:
    assert guard.reexec_in_host_mount_namespace(
        original_argv[0], argv=original_argv, environment={"PRESERVE": "yes"},
    ) is False
    assert same_identity.call_args_list == [
        mock.call("/proc/self/ns/mnt"), mock.call("/proc/1/ns/mnt"),
    ]
    nsenter_validation.assert_not_called()
    runner.assert_not_called()

identities = {
    guard.SELF_MOUNT_NAMESPACE: (7, 11),
    guard.HOST_MOUNT_NAMESPACE: (7, 29),
}
observed = {}
def successful_runner(command, **kwargs):
    observed["command"] = command
    observed["kwargs"] = kwargs
    return SimpleNamespace(returncode=0)

source_environment = {"PRESERVE": "yes"}
with mock.patch.object(guard, "mount_namespace_identity", side_effect=lambda path: identities[path]), \
        mock.patch.object(guard, "validate_nsenter_executable") as nsenter_validation, \
        mock.patch.object(guard.subprocess, "run", side_effect=successful_runner) as runner:
    assert guard.reexec_in_host_mount_namespace(
        original_argv[0], argv=original_argv, environment=source_environment,
    ) is True
    nsenter_validation.assert_called_once_with()
    runner.assert_called_once()

assert observed["command"] == [
    "/usr/bin/nsenter", "--mount=/proc/1/ns/mnt", "--", *original_argv,
]
assert observed["kwargs"]["stdin"] is guard.subprocess.DEVNULL
assert observed["kwargs"]["check"] is False
assert "shell" not in observed["kwargs"]
assert observed["kwargs"]["env"]["PRESERVE"] == "yes"
assert observed["kwargs"]["env"][guard.MOUNT_NAMESPACE_REEXEC_MARKER] == "7:29"
assert source_environment == {"PRESERVE": "yes"}

with mock.patch.object(guard, "mount_namespace_identity", side_effect=lambda path: identities[path]), \
        mock.patch.object(guard, "validate_nsenter_executable") as nsenter_validation, \
        mock.patch.object(guard.subprocess, "run") as runner:
    try:
        guard.reexec_in_host_mount_namespace(
            original_argv[0], argv=original_argv,
            environment={guard.MOUNT_NAMESPACE_REEXEC_MARKER: ""},
        )
    except guard.GuardError as error:
        assert error.code == "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_LOOP", error.code
    else:
        raise AssertionError("namespace drift with an existing loop marker was admitted")
    nsenter_validation.assert_not_called()
    runner.assert_not_called()

with mock.patch.object(guard, "mount_namespace_identity", side_effect=lambda path: identities[path]), \
        mock.patch.object(guard, "validate_nsenter_executable") as nsenter_validation, \
        mock.patch.object(guard.subprocess, "run") as runner:
    try:
        guard.reexec_in_host_mount_namespace(
            original_argv[0], argv=["/different/guard", *original_argv[1:]], environment={},
        )
    except guard.GuardError as error:
        assert error.code == "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_INVALID", error.code
    else:
        raise AssertionError("namespace re-exec admitted a different guard argv[0]")
    nsenter_validation.assert_not_called()
    runner.assert_not_called()

for failed_runner in (
    mock.Mock(return_value=SimpleNamespace(returncode=17)),
    mock.Mock(side_effect=OSError(errno.ENOENT, "missing")),
):
    with mock.patch.object(guard, "mount_namespace_identity", side_effect=lambda path: identities[path]), \
            mock.patch.object(guard, "validate_nsenter_executable"), \
            mock.patch.object(guard.subprocess, "run", failed_runner):
        try:
            guard.reexec_in_host_mount_namespace(
                original_argv[0], argv=original_argv, environment={},
            )
        except guard.GuardError as error:
            assert error.code == "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_FAILED", error.code
        else:
            raise AssertionError("failed nsenter execution was admitted")

main_argv = [original_argv[0], "--unit", "shein-bi-portal.service"]
with mock.patch.object(sys, "argv", main_argv), \
        mock.patch.object(guard, "validate_guard_executable", return_value=original_argv[0]), \
        mock.patch.object(guard, "reexec_in_host_mount_namespace", return_value=True) as reexec, \
        mock.patch.object(guard, "run") as local_run:
    assert guard.main() == 0
    reexec.assert_called_once_with(original_argv[0])
    local_run.assert_not_called()

stderr = io.StringIO()
namespace_failure = guard.GuardError(
    "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_FAILED", "nsenter:1",
)
with mock.patch.object(sys, "argv", main_argv), \
        mock.patch.object(guard, "validate_guard_executable", return_value=original_argv[0]), \
        mock.patch.object(guard, "reexec_in_host_mount_namespace", side_effect=namespace_failure), \
        contextlib.redirect_stderr(stderr):
    assert guard.main() == 78
failure = json.loads(stderr.getvalue())
assert failure["ok"] is False
assert failure["code"] == "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_FAILED"
PY
}

if [[ "${1:-}" == --namespace-reexec-unit-only ]]; then
  [[ "$#" == 1 ]]
  run_mount_namespace_reexec_tests
  printf '{"ok":true,"checks":["mount_namespace_device_inode_identity","same_namespace_no_reexec","different_namespace_exact_nsenter_argv","private_loop_marker_fail_closed","guard_argv_identity_fail_closed","nsenter_failures_map_to_78","reexec_precedes_guard_validation"]}\n'
  exit 0
fi

if [[ "$(id -u)" != 0 ]]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    exec sudo env INVENTORY_GUARD_TEST_ROOT=1 "$0" "$@"
  fi
  exec unshare -Urmfp --mount-proc -- env INVENTORY_GUARD_TEST_USERNS=1 "$0" "$@"
fi
if [[ "${INVENTORY_GUARD_TEST_USERNS:-}" == 1 ]]; then
  mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /tmp
fi

run_mount_namespace_reexec_tests
TMP="$(mktemp -d)"
cleanup(){
  if [[ "${GUARD_MOUNTED_STATE:-0}" == 1 ]]; then umount "$APP/state" >/dev/null 2>&1 || true; fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT
APP="$TMP/app"; SYSTEMD="$TMP/systemd"; LIBEXEC="$TMP/libexec"; CONTROL="$TMP/control"; LOG="$TMP/systemctl.log"
mkdir -p "$APP" "$SYSTEMD" "$LIBEXEC" "$CONTROL"
git -C "$APP" init -q
git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-guard-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$APP/.gitignore"
printf 'old\n' >"$APP/tracked.txt"
mkdir -p "$APP/outputs"
printf 'tracked output\n' >"$APP/outputs/tracked-output.txt"
git -C "$APP" add .gitignore tracked.txt
git -C "$APP" add -f outputs/tracked-output.txt
git -C "$APP" commit -qm old
OLD="$(git -C "$APP" rev-parse HEAD)"
printf 'new\n' >"$APP/tracked.txt"; git -C "$APP" commit -qam new
NEW="$(git -C "$APP" rev-parse HEAD)"
printf 'next\n' >"$APP/tracked.txt"; git -C "$APP" commit -qam next
NEXT="$(git -C "$APP" rev-parse HEAD)"
git -C "$APP" checkout -q --detach "$NEW"
mkdir -p "$APP/state" "$APP/tmp" "$APP/outputs" "$APP/profiles" "$APP/node_modules"

TARGET="$LIBEXEC/shein-bi-inventory-writer-compatibility-guard"
ACTIVATION="$CONTROL/activation.ndjson"; RECEIPT="$CONTROL/activation.receipt.json"
COMPATIBILITY="$CONTROL/compatibility.ndjson"; COMPATIBILITY_RECEIPT="$CONTROL/compatibility.receipt.json"
FAKE_SYSTEMCTL="$TMP/systemctl"
cat >"$FAKE_SYSTEMCTL" <<'SH'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == daemon-reload ]]; then printf 'daemon-reload\n' >>"$SYSTEMCTL_LOG"; exit 0; fi
if [[ "$1" == show ]]; then
  unit="${!#}"
  expected="$GUARD_TARGET --unit $unit --systemctl-bin $FAKE_SYSTEMCTL_PATH --app-root $GUARD_APP --activation-file $GUARD_ACTIVATION --activation-receipt-file $GUARD_RECEIPT --compatibility-file $GUARD_COMPATIBILITY --compatibility-receipt-file $GUARD_COMPATIBILITY_RECEIPT"
  if [[ "${MUTATION_AFTER_GUARD:-0}" == 1 ]]; then
    printf '{ path=%s ; argv[]=%s ; } { path=/bin/true ; argv[]=/bin/true ; }\n' "$GUARD_TARGET" "$expected"
  else
    printf '{ path=%s ; argv[]=%s ; }\n' "$GUARD_TARGET" "$expected"
  fi
  exit 0
fi
exit 64
SH
chmod 0755 "$FAKE_SYSTEMCTL"
export SYSTEMCTL_LOG="$LOG" GUARD_TARGET="$TARGET" FAKE_SYSTEMCTL_PATH="$FAKE_SYSTEMCTL" GUARD_APP="$APP"
export GUARD_ACTIVATION="$ACTIVATION" GUARD_RECEIPT="$RECEIPT" GUARD_COMPATIBILITY="$COMPATIBILITY" GUARD_COMPATIBILITY_RECEIPT="$COMPATIBILITY_RECEIPT"

install_args=(--root "$ROOT" --systemd-dir "$SYSTEMD" --libexec-dir "$LIBEXEC" --control-dir "$CONTROL" --app-root "$APP" --systemctl-bin "$FAKE_SYSTEMCTL" --guard-systemctl-bin "$FAKE_SYSTEMCTL" --service-group 0)
bash "$ROOT/scripts/install_inventory_writer_compatibility_guard.sh" "${install_args[@]}" >/dev/null
bash "$ROOT/scripts/install_inventory_writer_compatibility_guard.sh" "${install_args[@]}" --apply --confirm INSTALL_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1 >/dev/null
[[ "$(stat -c %u:%a "$TARGET")" == '0:755' ]]
AUDIT_JSON="$(bash "$ROOT/scripts/install_inventory_writer_compatibility_guard.sh" "${install_args[@]}")"
INSTALLED_MANIFEST="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["installedManifestSha256"])' <<<"$AUDIT_JSON")"
set +e
bash "$ROOT/scripts/install_inventory_writer_compatibility_guard.sh" "${install_args[@]}" --replace --expected-installed-manifest-sha256 "$(printf 'f%.0s' {1..64})" --confirm REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1 >/dev/null 2>&1
WRONG_REPLACE=$?
set -e
[[ "$WRONG_REPLACE" == 64 ]]
bash "$ROOT/scripts/install_inventory_writer_compatibility_guard.sh" "${install_args[@]}" --replace --expected-installed-manifest-sha256 "$INSTALLED_MANIFEST" --confirm REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1 >/dev/null
[[ "$(cat "$LOG")" == $'daemon-reload\ndaemon-reload' ]]
SERVICES=(shein-bi-cloud-marketing-repair.service shein-bi-cloud-morning-chain.service shein-bi-daily-inventory-replenishment-guard.service shein-bi-et-low-inventory-guard.service shein-bi-et-low-inventory-recheck.service shein-bi-portal.service)
for service in "${SERVICES[@]}"; do
  dropin="$SYSTEMD/$service.d/10-inventory-writer-compatibility.conf"
  [[ -f "$dropin" && ! -L "$dropin" && "$(stat -c %u:%a "$dropin")" == '0:644' ]]
  grep -Fxq "ExecStartPre=+$TARGET --unit %n --systemctl-bin $FAKE_SYSTEMCTL --app-root $APP --activation-file $ACTIVATION --activation-receipt-file $RECEIPT --compatibility-file $COMPATIBILITY --compatibility-receipt-file $COMPATIBILITY_RECEIPT" "$dropin"
done

guard(){ "$TARGET" --unit shein-bi-portal.service --systemctl-bin "$FAKE_SYSTEMCTL" --app-root "$APP" --activation-file "$ACTIVATION" --activation-receipt-file "$RECEIPT" --compatibility-file "$COMPATIBILITY" --compatibility-receipt-file "$COMPATIBILITY_RECEIPT" --filesystem-trust-root "$TMP"; }
reject(){ set +e; guard >/dev/null 2>&1; code=$?; set -e; [[ "$code" == 78 ]]; }
reject_direct(){ set +e; "$@" >/dev/null 2>&1; code=$?; set -e; [[ "$code" == 78 ]]; }

guard | grep -q 'pre_activation_compatible'
export MUTATION_AFTER_GUARD=1; reject; unset MUTATION_AFTER_GUARD

PERMISSION_RECEIPT="$CONTROL/source-permissions.receipt.json"
PERMISSION_PLAN="$CONTROL/source-permissions.plan.json"
PERMISSION_COMPLETION="$CONTROL/source-permissions.completion.json"
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" \
  --generation-id guard-generation-v1 --plan-file "$PERMISSION_PLAN" \
  --completion-attestation "$PERMISSION_COMPLETION" >/dev/null
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" \
  --generation-id guard-generation-v1 --plan-file "$PERMISSION_PLAN" \
  --completion-attestation "$PERMISSION_COMPLETION" --apply \
  --expected-recovery-plan-sha256 "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planHash"])' <"$PERMISSION_PLAN")" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" \
  --plan-file "$PERMISSION_PLAN" --completion-attestation "$PERMISSION_COMPLETION" | grep -q '"ok":true'
[[ "$(stat -c %u:%g:%a "$APP")" == '0:0:750' ]]
[[ "$(stat -c %u:%g:%a "$APP/.git")" == '0:0:750' ]]
[[ "$(stat -c %u:%g:%a "$APP/tracked.txt")" == '0:0:640' ]]
[[ "$(stat -c %u:%g:%a "$APP/outputs/tracked-output.txt")" == '0:0:640' ]]
for runtime in state tmp outputs profiles node_modules; do [[ "$(stat -c %u:%g:%a "$APP/$runtime")" == '0:0:1770' ]]; done

APP="$APP" python3 - <<'PY'
import os,stat
app=os.environ['APP']; uid=12345; gid=0
def allowed(path,mask):
    s=os.stat(path); mode=stat.S_IMODE(s.st_mode)
    shift=6 if s.st_uid==uid else 3 if s.st_gid==gid else 0
    return bool(((mode>>shift)&7)&mask)
assert not allowed(os.path.join(app,'.git','index'),2)
assert not allowed(os.path.join(app,'tracked.txt'),2)
for name in ('state','tmp','outputs','profiles','node_modules'):
    assert allowed(os.path.join(app,name),3), name
PY

write_control_state(){
  MODE="$1" EXPECTED_COMMIT="$2" ACTIVATION="$ACTIVATION" RECEIPT="$RECEIPT" COMPATIBILITY="$COMPATIBILITY" COMPATIBILITY_RECEIPT="$COMPATIBILITY_RECEIPT" python3 - <<'PY'
import hashlib,json,os
def enc(v): return json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def h(v): return hashlib.sha256(enc(v)).hexdigest()
def full(commit,marker):
    return {'deployedCommit':commit,'sourceFingerprint':marker*64,'bundleSha256':'2'*64,'trackedSourceClean':True,'releaseReceiptKind':'formal','releaseReceiptHash':'3'*64,'releaseReceiptFile':'/var/lib/release.json','writerServices':[{'unit':'shein-bi-portal.service','generationHash':'4'*64}],'capturedAt':'2026-08-27T00:00:00.000Z'}
def identity(authority):
    return {key:authority[key] for key in ('deployedCommit','sourceFingerprint','bundleSha256','trackedSourceClean','releaseReceiptKind','releaseReceiptHash','releaseReceiptFile')}
mode=os.environ['MODE']; commit=os.environ['EXPECTED_COMMIT']; ap=os.environ['ACTIVATION']; rp=os.environ['RECEIPT']; cp=os.environ['COMPATIBILITY']; crp=os.environ['COMPATIBILITY_RECEIPT']
if mode=='initial':
    authority=full(commit,'1')
    required={'intentId':'e07f999c-96b2-460c-bfa9-fa924f410ec3','scopeKey':'5'*64,'journalFile':'/srv/journal.ndjson','receiptFile':'/srv/manual.receipt.json'}
    core={'schemaVersion':'inventory-v2-reader-first-activation/v1','kind':'reader_first_activation','readerSchemaVersion':'inventory-manual-resolution/v1','authority':authority,'requiredManualResolution':required,'activatedAt':'2026-08-27T00:01:00.000Z'}
    activation={**core,'activationHash':h(core)}; raw=enc(activation)+b'\n'; open(ap,'wb').write(raw)
    rcore={'schemaVersion':'inventory-v2-reader-first-activation-receipt/v1','kind':'reader_first_activation_receipt','activationFile':ap,'activationFileSha256':hashlib.sha256(raw).hexdigest(),'activationHash':activation['activationHash'],'recordedAt':'2026-08-27T00:01:00.000Z'}
    open(rp,'wb').write(enc({**rcore,'receiptHash':h(rcore)})+b'\n')
    initial={'schemaVersion':'inventory-v2-compatibility-record/v1','kind':'compatibility_initial','generation':1,'activationHash':activation['activationHash'],'authority':authority,'requiredManualResolutionHash':h(required),'recordedAt':'2026-08-27T00:01:01.000Z'}
    records=[{**initial,'recordHash':h(initial)}]
else:
    activation=json.loads(open(ap,encoding='utf-8').read()); records=[json.loads(line) for line in open(cp,encoding='utf-8') if line.strip()]
    active=next(record for record in reversed(records) if record['kind'] in ('compatibility_initial','compatibility_rotation_finalized'))
    if mode=='stage':
        candidate=identity(full(commit,'6'))
        stage={'schemaVersion':'inventory-v2-compatibility-record/v1','kind':'compatibility_rotation_staged','generation':active['generation']+1,'previousGeneration':active['generation'],'previousFinalizedHash':active['recordHash'],'candidateAuthority':candidate,'currentStateHash':'7'*64,'maintenance':{'generation':9,'hash':'8'*64},'recordedAt':'2026-08-27T00:02:00.000Z'}
        records.append({**stage,'recordHash':h(stage)})
    elif mode=='finalize':
        pending=next(record for record in reversed(records) if record['kind']=='compatibility_rotation_staged')
        authority={**pending['candidateAuthority'],'writerServices':[{'unit':'shein-bi-portal.service','generationHash':'9'*64}],'capturedAt':'2026-08-27T00:03:00.000Z'}
        final={'schemaVersion':'inventory-v2-compatibility-record/v1','kind':'compatibility_rotation_finalized','generation':pending['generation'],'previousGeneration':active['generation'],'previousFinalizedHash':active['recordHash'],'stageHash':pending['recordHash'],'authority':authority,'maintenance':{'generation':10,'hash':'a'*64},'recordedAt':'2026-08-27T00:03:00.000Z'}
        records.append({**final,'recordHash':h(final)})
    else: raise AssertionError(mode)
craw=b''.join(enc(record)+b'\n' for record in records); open(cp,'wb').write(craw)
active=next(record for record in reversed(records) if record['kind'] in ('compatibility_initial','compatibility_rotation_finalized'))
pending=next((record for record in reversed(records) if record['kind']=='compatibility_rotation_staged' and record['generation']>active['generation']),None)
ccore={'schemaVersion':'inventory-v2-compatibility-receipt/v1','kind':'inventory_compatibility_receipt','compatibilityFile':cp,'compatibilityFileSha256':hashlib.sha256(craw).hexdigest(),'lastRecordHash':records[-1]['recordHash'],'activeGeneration':active['generation'],'activeRecordHash':active['recordHash'],'pendingStageHash':pending['recordHash'] if pending else '','recordedAt':'2026-08-27T00:04:00.000Z'}
open(crp,'wb').write(enc({**ccore,'receiptHash':h(ccore)})+b'\n')
PY
  chown 0:0 "$ACTIVATION" "$RECEIPT" "$COMPATIBILITY" "$COMPATIBILITY_RECEIPT"
  chmod 0640 "$ACTIVATION" "$RECEIPT" "$COMPATIBILITY" "$COMPATIBILITY_RECEIPT"
}

write_control_state initial "$NEW"
guard | grep -q 'activated_exact'
GUARD_SOURCE_JSON="$(guard)"
GUARD_SOURCE_JSON="$GUARD_SOURCE_JSON" APP="$APP" python3 - <<'PY'
import json, os
value = json.loads(os.environ["GUARD_SOURCE_JSON"])
assert any(path.endswith("/outputs/tracked-output.txt") for path in value["managedSource"]["paths"])
assert value["managedRuntime"]["roots"] == ["state", "tmp", "outputs", "profiles", "node_modules"]
assert not value["excludedRuntimeRoots"]
PY

# The external-parent owner policy must allow a non-service non-root owner
# without group/other write, reject the service owner with owner-write, and
# continue to allow root ownership.
UNSAFE_PARENT="$TMP/unsafe-parent"; UNSAFE_APP="$UNSAFE_PARENT/app"
mkdir -p "$UNSAFE_APP"
chmod 0755 "$UNSAFE_PARENT"
git -C "$UNSAFE_APP" init -q
git -C "$UNSAFE_APP" config user.email test@example.invalid
git -C "$UNSAFE_APP" config user.name inventory-guard-parent-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$UNSAFE_APP/.gitignore"
printf 'unsafe parent\n' >"$UNSAFE_APP/tracked.txt"
git -C "$UNSAFE_APP" add .gitignore tracked.txt
git -C "$UNSAFE_APP" commit -qm unsafe-parent
mkdir -p "$UNSAFE_APP/state" "$UNSAFE_APP/tmp" "$UNSAFE_APP/outputs" "$UNSAFE_APP/profiles" "$UNSAFE_APP/node_modules"
chmod 0750 "$UNSAFE_APP" "$UNSAFE_APP/.git"
chmod 0640 "$UNSAFE_APP/.gitignore" "$UNSAFE_APP/tracked.txt"
chmod 1770 "$UNSAFE_APP/state" "$UNSAFE_APP/tmp" "$UNSAFE_APP/outputs" "$UNSAFE_APP/profiles" "$UNSAFE_APP/node_modules"
ROOT="$ROOT" UNSAFE_APP="$UNSAFE_APP" python3 - <<'PY'
import importlib.util
import os

script = os.path.join(os.environ["ROOT"], "infra", "inventory_writer_compatibility_guard.py")
spec = importlib.util.spec_from_file_location("inventory_compatibility_guard_parent_test", script)
guard_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard_module)
parent = os.path.dirname(os.environ["UNSAFE_APP"])
app = os.environ["UNSAFE_APP"]
service_uid = 1003
other_uid = 1000

def admitted(owner):
    os.chown(parent, owner, 0)
    os.chmod(parent, 0o755)
    scope = guard_module.validate_source_permissions(app, ["tracked.txt"], service_uid=service_uid)
    assert scope["appRoot"] == app

admitted(other_uid)

os.chown(parent, service_uid, 0)
os.chmod(parent, 0o755)
try:
    guard_module.validate_source_permissions(app, ["tracked.txt"], service_uid=service_uid)
except guard_module.GuardError as error:
    assert error.code == "INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", error.code
    assert "external parent permits service rename" in str(error), str(error)
else:
    raise AssertionError("service-owned writable external parent was admitted")

admitted(0)
PY
chmod 0555 "$APP/state" "$APP/profiles"
GUARD_RO_JSON="$(guard)"
GUARD_RO_JSON="$GUARD_RO_JSON" python3 - <<'PY'
import json, os
value = json.loads(os.environ["GUARD_RO_JSON"])
assert {row["name"] for row in value["excludedRuntimeRoots"]} == {"state", "profiles"}
assert not value["externalRuntimeMounts"]
PY
chmod 1770 "$APP/state" "$APP/profiles"
GUARD_MOUNTED_STATE=0
GUARD_MOUNT_SOURCE="$TMP/guard-mount-source"
mkdir -p "$GUARD_MOUNT_SOURCE/state"
printf 'guard mount sentinel\n' >"$GUARD_MOUNT_SOURCE/state/sentinel.txt"
if mount --bind "$GUARD_MOUNT_SOURCE/state" "$APP/state" >/dev/null 2>&1; then
  GUARD_MOUNTED_STATE=1
  if ! mount -o remount,bind,ro "$APP/state" >/dev/null 2>&1; then
    umount "$APP/state" >/dev/null 2>&1 || true
    GUARD_MOUNTED_STATE=0
  fi
fi
if [[ "$GUARD_MOUNTED_STATE" == 1 ]]; then
  GUARD_RUNTIME_MODE=bind-ro
  GUARD_BIND_JSON="$(guard)"
  GUARD_BIND_JSON="$GUARD_BIND_JSON" APP="$APP" python3 - <<'PY'
import json, os
value = json.loads(os.environ["GUARD_BIND_JSON"])
state = os.path.join(os.environ["APP"], "state")
assert any(row["mountpoint"] == state and row["roRw"] == "ro" for row in value["externalRuntimeMounts"])
assert {row["name"] for row in value["excludedRuntimeRoots"]} == {"state"}
PY
  umount "$APP/state"
  GUARD_MOUNTED_STATE=0
else
  GUARD_RUNTIME_MODE=mode-equivalent
  chmod 0555 "$APP/state"
  GUARD_MODE_JSON="$(guard)"
  GUARD_MODE_JSON="$GUARD_MODE_JSON" python3 - <<'PY'
import json, os
value = json.loads(os.environ["GUARD_MODE_JSON"])
assert {row["name"] for row in value["excludedRuntimeRoots"]} == {"state", "profiles"}
assert not value["externalRuntimeMounts"]
PY
  chmod 1770 "$APP/state"
fi
git -C "$APP" checkout -q --detach "$OLD"; reject
git -C "$APP" checkout -q --detach "$NEW"; chmod 0640 "$APP/tracked.txt" "$APP/.gitignore"
write_control_state initial 5cc31c12476bceed5e670dc49a04e274c976f98e; reject
write_control_state initial "$NEW"

cp "$ACTIVATION" "$TMP/activation.saved"; rm "$ACTIVATION"; reject; mv "$TMP/activation.saved" "$ACTIVATION"; chmod 0640 "$ACTIVATION"
rm "$RECEIPT"; reject; write_control_state initial "$NEW"
printf ' ' >>"$ACTIVATION"; reject; write_control_state initial "$NEW"
RECEIPT="$RECEIPT" python3 - <<'PY'
import json,os
p=os.environ['RECEIPT']; value=json.load(open(p,encoding='utf-8')); value['recordedAt']='2026-08-27T00:02:00.000Z'; open(p,'w',encoding='utf-8').write(json.dumps(value,separators=(',',':'))+'\n')
PY
reject; write_control_state initial "$NEW"
rm "$COMPATIBILITY_RECEIPT"; reject; write_control_state initial "$NEW"
printf ' ' >>"$COMPATIBILITY"; reject; write_control_state initial "$NEW"

printf 'dirty\n' >>"$APP/tracked.txt"; reject; git -C "$APP" checkout -q -- tracked.txt; chmod 0640 "$APP/tracked.txt"
git -C "$APP" update-index --skip-worktree tracked.txt; reject; git -C "$APP" update-index --no-skip-worktree tracked.txt
git -C "$APP" update-index --assume-unchanged tracked.txt; reject; git -C "$APP" update-index --no-assume-unchanged tracked.txt
rm "$APP/tracked.txt"; reject; git -C "$APP" checkout -q -- tracked.txt; chmod 0640 "$APP/tracked.txt"
chmod 0660 "$APP/tracked.txt"; reject; chmod 0640 "$APP/tracked.txt"
TRACKED_HARDLINK_VICTIM="$TMP/tracked-hardlink-victim.txt"
TRACKED_HARDLINK_PARKED="$TMP/tracked-hardlink-parked.txt"
cp -p "$APP/tracked.txt" "$TRACKED_HARDLINK_VICTIM"
TRACKED_HARDLINK_VICTIM_STAT="$(stat -c '%u:%g:%a:%s' "$TRACKED_HARDLINK_VICTIM")"
mv "$APP/tracked.txt" "$TRACKED_HARDLINK_PARKED"
ln "$TRACKED_HARDLINK_VICTIM" "$APP/tracked.txt"
reject
[[ "$(stat -c '%u:%g:%a:%s' "$TRACKED_HARDLINK_VICTIM")" == "$TRACKED_HARDLINK_VICTIM_STAT" ]]
rm "$APP/tracked.txt"
mv "$TRACKED_HARDLINK_PARKED" "$APP/tracked.txt"
chmod 0770 "$APP"; reject; chmod 0750 "$APP"
chmod 0770 "$APP/.git"; reject; chmod 0750 "$APP/.git"
chmod 0777 "$APP/tmp"; reject; chmod 1770 "$APP/tmp"
chmod 0666 "$RECEIPT"; reject; chmod 0640 "$RECEIPT"
chmod 0777 "$TARGET"; reject; chmod 0755 "$TARGET"

export MUTATION_AFTER_GUARD=1; reject; unset MUTATION_AFTER_GUARD
mv "$TARGET" "$TARGET.real"; ln -s "$TARGET.real" "$TARGET"
reject_direct "$TARGET" --unit shein-bi-portal.service --systemctl-bin "$FAKE_SYSTEMCTL" --app-root "$APP" --activation-file "$ACTIVATION" --activation-receipt-file "$RECEIPT" --compatibility-file "$COMPATIBILITY" --compatibility-receipt-file "$COMPATIBILITY_RECEIPT" --filesystem-trust-root "$TMP"
rm "$TARGET"; mv "$TARGET.real" "$TARGET"

write_control_state initial "$NEW"
write_control_state stage "$NEXT"
git -C "$APP" checkout -q --detach "$NEXT"; chmod 0640 "$APP/tracked.txt" "$APP/.gitignore"
guard | grep -q 'rotation_candidate_staged'
write_control_state finalize "$NEXT"
guard | grep -q 'activated_exact'
git -C "$APP" checkout -q --detach "$NEW"; chmod 0640 "$APP/tracked.txt" "$APP/.gitignore"; reject
git -C "$APP" checkout -q --detach "$NEXT"; chmod 0640 "$APP/tracked.txt" "$APP/.gitignore"
guard >/dev/null

PERMISSION_RECEIPT_SHA="$(sha256sum "$PERMISSION_RECEIPT" | awk '{print $1}')"
PERMISSION_COMPLETION_SHA="$(sha256sum "$PERMISSION_COMPLETION" | awk '{print $1}')"
PERMISSION_PLAN_SHA="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planHash"])' <"$PERMISSION_PLAN")"

printf 'deployment generation\n' >"$APP/deployment-generation.txt"
git -C "$APP" add deployment-generation.txt
git -C "$APP" commit -qm deployment-generation
DEPLOYMENT_GENERATION="$(git -C "$APP" rev-parse HEAD)"
chmod 0644 "$APP/deployment-generation.txt"
write_control_state initial "$DEPLOYMENT_GENERATION"
GUARD_GENERATION_JSON="$(guard)"
GUARD_GENERATION_JSON="$GUARD_GENERATION_JSON" DEPLOYMENT_GENERATION="$DEPLOYMENT_GENERATION" APP="$APP" python3 - <<'PY'
import json, os
value = json.loads(os.environ["GUARD_GENERATION_JSON"])
generation = value["currentSourceGeneration"]
assert value["ok"] is True and value["deployedCommit"] == os.environ["DEPLOYMENT_GENERATION"]
assert generation["headCommit"] == os.environ["DEPLOYMENT_GENERATION"]
assert generation["generationId"] == "current:" + os.environ["DEPLOYMENT_GENERATION"]
assert len(generation["generationHash"]) == 64
assert os.path.join(os.environ["APP"], "deployment-generation.txt") in value["managedSource"]["paths"]
PY
PERMISSION_HISTORY_AUDIT="$TMP/permission-history-audit.json"
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" \
  --plan-file "$PERMISSION_PLAN" --completion-attestation "$PERMISSION_COMPLETION" \
  >"$PERMISSION_HISTORY_AUDIT"
GUARD_GENERATION_JSON="$GUARD_GENERATION_JSON" PERMISSION_HISTORY_AUDIT="$PERMISSION_HISTORY_AUDIT" python3 - <<'PY'
import json, os
guard = json.loads(os.environ["GUARD_GENERATION_JSON"])
hardener = json.load(open(os.environ["PERMISSION_HISTORY_AUDIT"], encoding="utf-8"))
assert hardener["ok"] is True
assert hardener["generationRelation"] == "historical_completion_current_scope_advanced"
assert hardener["currentGeneration"] == guard["currentSourceGeneration"]
PY
DEPLOYMENT_FILE_STAT="$(stat -c '%u:%g:%a:%s' "$APP/deployment-generation.txt")"
set +e
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" --rollback \
  --expected-receipt-sha256 "$(printf 'f%.0s' {1..64})" \
  --expected-recovery-plan-sha256 "$PERMISSION_PLAN_SHA" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
WRONG_PERMISSION_ROLLBACK=$?
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" --rollback \
  --plan-file "$PERMISSION_PLAN" --expected-receipt-sha256 "$PERMISSION_RECEIPT_SHA" \
  --expected-recovery-plan-sha256 "$PERMISSION_PLAN_SHA" \
  --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
OLD_GENERATION_ROLLBACK=$?
set -e
[[ "$WRONG_PERMISSION_ROLLBACK" == 1 && "$OLD_GENERATION_ROLLBACK" == 1 ]]
[[ "$(stat -c '%u:%g:%a:%s' "$APP/deployment-generation.txt")" == "$DEPLOYMENT_FILE_STAT" ]]
[[ "$(sha256sum "$PERMISSION_RECEIPT" | awk '{print $1}')" == "$PERMISSION_RECEIPT_SHA" ]]
[[ "$(sha256sum "$PERMISSION_COMPLETION" | awk '{print $1}')" == "$PERMISSION_COMPLETION_SHA" ]]

NEXT_PERMISSION_RECEIPT="$CONTROL/source-permissions-$DEPLOYMENT_GENERATION.receipt.json"
NEXT_PERMISSION_PLAN="$CONTROL/source-permissions-$DEPLOYMENT_GENERATION.plan.json"
NEXT_PERMISSION_COMPLETION="$CONTROL/source-permissions-$DEPLOYMENT_GENERATION.completion.json"
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$NEXT_PERMISSION_RECEIPT" \
  --generation-id "deployment:$DEPLOYMENT_GENERATION" --plan-file "$NEXT_PERMISSION_PLAN" \
  --completion-attestation "$NEXT_PERMISSION_COMPLETION" >/dev/null
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" \
  --app-root "$APP" --service-group 0 --receipt "$NEXT_PERMISSION_RECEIPT" \
  --generation-id "deployment:$DEPLOYMENT_GENERATION" --plan-file "$NEXT_PERMISSION_PLAN" \
  --completion-attestation "$NEXT_PERMISSION_COMPLETION" --apply \
  --expected-recovery-plan-sha256 "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["planHash"])' <"$NEXT_PERMISSION_PLAN")" \
  --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
[[ -s "$NEXT_PERMISSION_RECEIPT" && -s "$NEXT_PERMISSION_PLAN" && -s "$NEXT_PERMISSION_COMPLETION" ]]
guard >/dev/null

printf '{"ok":true,"roGuardRuntimeMode":"%s","checks":["mount_namespace_device_inode_identity","same_namespace_no_reexec","different_namespace_exact_nsenter_argv","private_loop_marker_fail_closed","guard_argv_identity_fail_closed","nsenter_failures_map_to_78","reexec_precedes_guard_validation","activation_absent_pass","guard_exact_once_and_last","post_guard_dropin_mutation_rejected","external_install_and_replace_cas","six_dropins_external_path","source_permission_hardening","tracked_outputs_managed_source","service_checkout_and_tracked_write_denied","runtime_allowlist_writable","ro_runtime_root_guard_mount_or_equivalent","permission_rollback_requires_exact_receipt_hash_and_plan","activation_and_compatibility_receipts","new_exact_commit_pass","old_and_5cc31c_rejected","missing_and_tampered_control_rejected","dirty_hidden_missing_source_rejected","source_owner_mode_drift_rejected","tracked_source_hardlink_rejected","guard_mode_and_symlink_rejected","external_parent_owner_policy_regression","external_parent_rename_guard_rejected","rotation_staged_candidate_pass","rotation_finalize_new_pass","rotation_finalize_old_rejected","guard_current_generation_full_source_audit","historical_completion_current_scope_advanced","old_generation_rollback_scope_rejected","new_generation_distinct_artifacts_apply"]}\n' "$GUARD_RUNTIME_MODE"
