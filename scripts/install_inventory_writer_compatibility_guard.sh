#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

readonly INSTALL_CONFIRM='INSTALL_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1'
readonly REPLACE_CONFIRM='REPLACE_INVENTORY_WRITER_COMPATIBILITY_GUARD_V1'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_DIR="${SHEIN_BI_SYSTEMD_DIR:-/etc/systemd/system}"
LIBEXEC_DIR="${SHEIN_BI_LIBEXEC_DIR:-/usr/local/libexec}"
CONTROL_DIR="${SHEIN_BI_INVENTORY_CONTROL_DIR:-/var/lib/shein-bi-control/inventory-writer-compatibility}"
APP_ROOT="${SHEIN_BI_APP_ROOT:-/opt/shein-bi/app}"
SYSTEMCTL_BIN="${SHEIN_BI_SYSTEMCTL_BIN:-systemctl}"
GUARD_SYSTEMCTL_BIN="${SHEIN_BI_GUARD_SYSTEMCTL_BIN:-/usr/bin/systemctl}"
SERVICE_GROUP="${SHEIN_BI_SERVICE_GROUP:-sheinops}"
LOCK_TICKET_DIR="${SHEIN_BI_INVENTORY_CUTOVER_TICKET_DIR:-/srv/shein-bi/runtime/locks/inventory-v2-cutover.lock.tickets}"
APPLY=0 REPLACE=0 CONFIRM='' EXPECTED_MANIFEST=''
readonly GUARD_NAME='shein-bi-inventory-writer-compatibility-guard'
readonly DROPIN_NAME='10-inventory-writer-compatibility.conf'
readonly -a SERVICES=(
  shein-bi-daily-inventory-replenishment-guard.service
  shein-bi-et-low-inventory-guard.service
  shein-bi-et-low-inventory-recheck.service
)
readonly -a LEGACY_NON_WRITER_SERVICES=(
  shein-bi-cloud-marketing-repair.service
  shein-bi-cloud-morning-chain.service
  shein-bi-portal.service
)

usage(){ printf '%s\n' "Usage: $0 [--root DIR --systemd-dir DIR --libexec-dir DIR --control-dir DIR --app-root DIR] [--apply --confirm $INSTALL_CONFIRM] [--replace --expected-installed-manifest-sha256 HASH --confirm $REPLACE_CONFIRM]" >&2; }
die(){ printf 'inventory_writer_guard_install_error=%s\n' "$1" >&2; exit 1; }
bad(){ printf 'configuration_error=%s\n' "$1" >&2; usage; exit 64; }

while (($#)); do case "$1" in
  --root) ROOT="$2"; shift 2;; --systemd-dir) SYSTEMD_DIR="$2"; shift 2;;
  --libexec-dir) LIBEXEC_DIR="$2"; shift 2;; --control-dir) CONTROL_DIR="$2"; shift 2;;
  --app-root) APP_ROOT="$2"; shift 2;; --systemctl-bin) SYSTEMCTL_BIN="$2"; shift 2;;
  --guard-systemctl-bin) GUARD_SYSTEMCTL_BIN="$2"; shift 2;;
  --service-group) SERVICE_GROUP="$2"; shift 2;; --apply) APPLY=1; shift;;
  --replace) APPLY=1; REPLACE=1; shift;; --confirm) CONFIRM="$2"; shift 2;;
  --expected-installed-manifest-sha256) EXPECTED_MANIFEST="$2"; shift 2;;
  -h|--help) usage; exit 0;; *) bad "unknown argument:$1";; esac; done

for value in "$ROOT" "$SYSTEMD_DIR" "$LIBEXEC_DIR" "$CONTROL_DIR" "$APP_ROOT" "$LOCK_TICKET_DIR"; do
  [[ "$value" == /* && "$value" != / ]] || bad 'all paths must be safe absolute paths'
done
ROOT="${ROOT%/}"; SYSTEMD_DIR="${SYSTEMD_DIR%/}"; LIBEXEC_DIR="${LIBEXEC_DIR%/}"; CONTROL_DIR="${CONTROL_DIR%/}"; APP_ROOT="${APP_ROOT%/}"
SOURCE="$ROOT/infra/inventory_writer_compatibility_guard.py"
TARGET="$LIBEXEC_DIR/$GUARD_NAME"
ACTIVATION="$CONTROL_DIR/activation.ndjson"
RECEIPT="$CONTROL_DIR/activation.receipt.json"
COMPATIBILITY="$CONTROL_DIR/compatibility.ndjson"
COMPATIBILITY_RECEIPT="$CONTROL_DIR/compatibility.receipt.json"
[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || die 'guard source missing or unsafe'

render_dropin(){ cat <<EOF
[Service]
ExecStartPre=+$TARGET --unit %n --systemctl-bin $GUARD_SYSTEMCTL_BIN --app-root $APP_ROOT --activation-file $ACTIVATION --activation-receipt-file $RECEIPT --compatibility-file $COMPATIBILITY --compatibility-receipt-file $COMPATIBILITY_RECEIPT
EOF
}

effective_exact_and_last(){
  EXPECTED_COMMAND="$1" python3 -c '
import os,re,sys
raw=sys.stdin.read().strip()
structured=[m.group(1).strip() for m in re.finditer(r"(?:^|[;{\s])argv\[\]=([^;}]*?)(?=\s*;|\s*\})",raw)]
commands=structured if structured else ([raw] if raw else [])
expected=os.environ["EXPECTED_COMMAND"]
print(f"{sum(command==expected for command in commands)}:{int(bool(commands) and commands[-1]==expected)}")
'
}

effective_has_guard(){
  EXPECTED_PREFIX="$1" python3 -c '
import os,re,sys
raw=sys.stdin.read().strip()
structured=[m.group(1).strip() for m in re.finditer(r"(?:^|[;{\s])argv\[\]=([^;}]*?)(?=\s*;|\s*\})",raw)]
commands=structured if structured else ([raw] if raw else [])
expected=os.environ["EXPECTED_PREFIX"]
print(int(any(command.startswith(expected) for command in commands)))
'
}

artifact_manifest(){
  {
    for file in "$TARGET" "${SERVICES[@]/#/$SYSTEMD_DIR/}" "${LEGACY_NON_WRITER_SERVICES[@]/#/$SYSTEMD_DIR/}"; do
      [[ "$file" == *.service ]] && file="$file.d/$DROPIN_NAME"
      if [[ -e "$file" || -L "$file" ]]; then
        if [[ -f "$file" && ! -L "$file" ]]; then
          printf '%s\tfile\t%s\t%s\t%s\t%s\n' "$file" "$(stat -c %u:%g "$file")" "$(stat -c %a "$file")" "$(stat -c %h "$file")" "$(sha256sum "$file"|awk '{print $1}')"
        else printf '%s\tunsafe\n' "$file"; fi
      else printf '%s\tmissing\n' "$file"; fi
    done
  } | sha256sum | awk '{print $1}'
}

canonical=1; present=0; legacy_present=0
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  present=$((present+1)); [[ -f "$TARGET" && ! -L "$TARGET" && "$(stat -c %u "$TARGET")" == 0 && "$(( 8#$(stat -c %a "$TARGET") & 8#022 ))" == 0 ]] || canonical=0
  cmp -s "$SOURCE" "$TARGET" || canonical=0
fi
for service in "${SERVICES[@]}"; do
  file="$SYSTEMD_DIR/$service.d/$DROPIN_NAME"
  if [[ -e "$file" || -L "$file" ]]; then
    present=$((present+1)); [[ -f "$file" && ! -L "$file" && "$(stat -c %u "$file")" == 0 && "$(( 8#$(stat -c %a "$file") & 8#022 ))" == 0 ]] || canonical=0
    cmp -s "$file" <(render_dropin) || canonical=0
  fi
done
for service in "${LEGACY_NON_WRITER_SERVICES[@]}"; do
  file="$SYSTEMD_DIR/$service.d/$DROPIN_NAME"
  if [[ -e "$file" || -L "$file" ]]; then
    legacy_present=$((legacy_present+1))
  fi
done
if ((present > 0)); then
  [[ -d "$LOCK_TICKET_DIR" && ! -L "$LOCK_TICKET_DIR" \
    && "$(stat -c %U:%G:%a "$LOCK_TICKET_DIR")" == "root:$SERVICE_GROUP:2770" ]] || canonical=0
fi
manifest="$(artifact_manifest)"
total=$((1+${#SERVICES[@]}))

if ((!APPLY)); then
  [[ ( "$present" == 0 || ( "$present" == "$total" && "$canonical" == 1 ) ) && "$legacy_present" == 0 ]] || die "partial-or-drifted installation manifest=$manifest"
  printf '{"ok":true,"mode":"audit","serviceCount":%d,"legacyCount":%d,"installedManifestSha256":"%s","state":"%s"}\n' "${#SERVICES[@]}" "$legacy_present" "$manifest" "$([[ "$present" == 0 && "$legacy_present" == 0 ]] && echo planned_install || echo unchanged)"
  exit 0
fi
((EUID==0)) || die 'apply requires root'
if ((REPLACE)); then
  [[ "$CONFIRM" == "$REPLACE_CONFIRM" && "$EXPECTED_MANIFEST" =~ ^[a-f0-9]{64}$ && "$EXPECTED_MANIFEST" == "$manifest" ]] || bad 'replace requires exact confirmation and installed manifest hash'
else
  [[ "$CONFIRM" == "$INSTALL_CONFIRM" ]] || bad 'install confirmation mismatch'
  [[ ( "$present" == 0 || ( "$present" == "$total" && "$canonical" == 1 ) ) && "$legacy_present" == 0 ]] || die "existing drift requires --replace manifest=$manifest"
fi

install -d -o root -g root -m 0755 "$LIBEXEC_DIR" "$SYSTEMD_DIR"
install -d -o root -g "$SERVICE_GROUP" -m 2750 "$CONTROL_DIR"
install -d -o root -g "$SERVICE_GROUP" -m 2770 "$LOCK_TICKET_DIR"
tmp="$(mktemp "$LIBEXEC_DIR/.${GUARD_NAME}.XXXXXX")"
install -o root -g root -m 0755 "$SOURCE" "$tmp"; mv -f "$tmp" "$TARGET"
for service in "${SERVICES[@]}"; do
  dir="$SYSTEMD_DIR/$service.d"; install -d -o root -g root -m 0755 "$dir"
  tmp="$(mktemp "$dir/.${DROPIN_NAME}.XXXXXX")"; render_dropin >"$tmp"; chown root:root "$tmp"; chmod 0644 "$tmp"; mv -f "$tmp" "$dir/$DROPIN_NAME"
done
for service in "${LEGACY_NON_WRITER_SERVICES[@]}"; do
  file="$SYSTEMD_DIR/$service.d/$DROPIN_NAME"
  if [[ -e "$file" || -L "$file" ]]; then
    rm -f -- "$file"
  fi
done
"$SYSTEMCTL_BIN" daemon-reload || die 'systemctl daemon-reload failed'
for service in "${SERVICES[@]}"; do
  effective="$("$SYSTEMCTL_BIN" show --no-pager --property=ExecStartPre --value "$service")" || die "systemctl show failed:$service"
  expected="$TARGET --unit $service --systemctl-bin $GUARD_SYSTEMCTL_BIN --app-root $APP_ROOT --activation-file $ACTIVATION --activation-receipt-file $RECEIPT --compatibility-file $COMPATIBILITY --compatibility-receipt-file $COMPATIBILITY_RECEIPT"
  [[ "$(effective_exact_and_last "$expected" <<<"$effective")" == '1:1' ]] || die "effective guard missing, altered, duplicated, or not last:$service"
done
for service in "${LEGACY_NON_WRITER_SERVICES[@]}"; do
  effective="$("$SYSTEMCTL_BIN" show --no-pager --property=ExecStartPre --value "$service")" || die "systemctl show failed:$service"
  [[ "$(effective_has_guard "$TARGET" <<<"$effective")" == '0' ]] || die "legacy service retained guard ExecStartPre:$service"
done
printf '{"ok":true,"mode":"%s","serviceCount":%d,"installedManifestSha256":"%s","daemonReload":true}\n' "$([[ "$REPLACE" == 1 ]] && echo replace || echo apply)" "${#SERVICES[@]}" "$(artifact_manifest)"
