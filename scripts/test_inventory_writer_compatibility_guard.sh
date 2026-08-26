#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$(id -u)" != 0 ]]; then
  exec unshare -Urm -- env INVENTORY_GUARD_TEST_USERNS=1 "$0" "$@"
fi
if [[ "${INVENTORY_GUARD_TEST_USERNS:-}" == 1 ]]; then
  mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs /tmp
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
APP="$TMP/app"; SYSTEMD="$TMP/systemd"; LIBEXEC="$TMP/libexec"; CONTROL="$TMP/control"; LOG="$TMP/systemctl.log"
mkdir -p "$APP" "$SYSTEMD" "$LIBEXEC" "$CONTROL"
git -C "$APP" init -q
git -C "$APP" config user.email test@example.invalid
git -C "$APP" config user.name inventory-guard-test
printf 'state/\ntmp/\noutputs/\nprofiles/\nnode_modules/\n' >"$APP/.gitignore"
printf 'old\n' >"$APP/tracked.txt"
git -C "$APP" add .gitignore tracked.txt
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
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" --apply --confirm HARDEN_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" | grep -q '"ok":true'
[[ "$(stat -c %u:%g:%a "$APP")" == '0:0:750' ]]
[[ "$(stat -c %u:%g:%a "$APP/.git")" == '0:0:750' ]]
[[ "$(stat -c %u:%g:%a "$APP/tracked.txt")" == '0:0:640' ]]
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
set +e
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" --rollback --expected-receipt-sha256 "$(printf 'f%.0s' {1..64})" --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null 2>&1
WRONG_PERMISSION_ROLLBACK=$?
set -e
[[ "$WRONG_PERMISSION_ROLLBACK" == 1 ]]
python3 "$ROOT/scripts/harden_inventory_writer_checkout_permissions.py" --app-root "$APP" --service-group 0 --receipt "$PERMISSION_RECEIPT" --rollback --expected-receipt-sha256 "$PERMISSION_RECEIPT_SHA" --confirm ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1 >/dev/null
[[ "$(stat -c %a "$APP")" == 755 && "$(stat -c %a "$APP/tracked.txt")" == 644 ]]

printf '{"ok":true,"checks":["activation_absent_pass","guard_exact_once_and_last","post_guard_dropin_mutation_rejected","external_install_and_replace_cas","six_dropins_external_path","source_permission_hardening","service_checkout_and_tracked_write_denied","runtime_allowlist_writable","permission_rollback_requires_exact_receipt_hash","activation_and_compatibility_receipts","new_exact_commit_pass","old_and_5cc31c_rejected","missing_and_tampered_control_rejected","dirty_hidden_missing_source_rejected","source_owner_mode_drift_rejected","guard_mode_and_symlink_rejected","rotation_staged_candidate_pass","rotation_finalize_new_pass","rotation_finalize_old_rejected"]}\n'
