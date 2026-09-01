#!/usr/bin/env bash
set -Eeuo pipefail

# Temp-only proof of the reviewed unit-private runtime path namespaces:
#   1. a host-level read-only bind only protects the *legacy target*, and
#   2. by itself it leaves the canonical source writable (the omission the
#      policy fix must close), while
#   3. BindReadOnlyPaths + ReadOnlyPaths together make BOTH the canonical
#      source and the legacy target non-writable, and
#   4. the effective namespace is visible through `systemctl show`, exactly
#      the property surface the runtime snapshot/watchdog compares, so an
#      omitted protection or an injected writable override is detectable.
# This never touches the application/data directories and creates no
# persistent unit.

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo 'probe_systemd_runtime_bind_paths.sh must run as root' >&2
  exit 77
fi

tmp="$(mktemp -d /tmp/shein-bi-bind-paths-probe.XXXXXX)"
case "$tmp" in
  /tmp/shein-bi-bind-paths-probe.*) ;;
  *) echo "unsafe probe directory: $tmp" >&2; exit 73 ;;
esac
src="$tmp/source"
dst="$tmp/host-view"
unit="shein-bi-bind-paths-probe-$RANDOM-$$.service"
omission_unit="shein-bi-bind-paths-probe-omission-$RANDOM-$$.service"
ro_unit="shein-bi-bind-paths-probe-ro-$RANDOM-$$.service"
readback_unit="shein-bi-bind-paths-probe-readback-$RANDOM-$$.service"
mounted=0

cleanup() {
  set +e
  systemctl stop "$unit" "$omission_unit" "$ro_unit" "$readback_unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" "$omission_unit" "$ro_unit" "$readback_unit" >/dev/null 2>&1 || true
  if [[ "$mounted" == 1 ]] && mountpoint -q "$dst"; then umount -- "$dst"; fi
  rm -f -- "$src/seed" "$src/unit-write" "$src/omission-write" "$src/canonical-write" \
      "$dst/host-write" "$dst/target-write" "$tmp/host-write" "$tmp/host-write.err" \
      "$tmp/effective.txt" "$tmp/probe-both-ro-ok" "$tmp/blocked-marker"
  rmdir -- "$src" "$dst" "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -m 0700 -- "$src" "$dst"
printf 'seed\\n' > "$src/seed"
mount --bind "$src" "$dst"
mounted=1
mount -o remount,bind,ro "$dst"
findmnt -rn -o OPTIONS --target "$dst" | grep -Eq '(^|,)ro(,|$)' || {
  echo 'host probe bind is not read-only' >&2
  exit 1
}

if touch "$dst/host-write" 2>"$tmp/host-write.err"; then
  echo 'host unexpectedly wrote through the read-only bind' >&2
  exit 1
fi
grep -Eqi 'read-only|只读' "$tmp/host-write.err" || {
  echo 'host write failed for an unexpected reason' >&2
  sed -n '1,3p' "$tmp/host-write.err" >&2
  exit 1
}

systemd-run \
  --quiet \
  --wait \
  --collect \
  --unit "$unit" \
  --property Type=oneshot \
  --property "BindPaths=$src:$dst" \
  /usr/bin/touch "$dst/unit-write"

[[ -f "$src/unit-write" ]] || {
  echo 'unit-private BindPaths write did not reach the canonical source' >&2
  exit 1
}
[[ ! -e "$dst/host-write" ]] || {
  echo 'failed host write left an unexpected artifact' >&2
  exit 1
}

# Omission proof: BindReadOnlyPaths alone (the old host-ro shape) only makes the
# legacy target read-only; the canonical source stays writable.  A verifier that
# only checks the bind would miss this, which is why ReadOnlyPaths must also be
# compared as an effective property.
systemd-run \
  --quiet \
  --wait \
  --collect \
  --unit "$omission_unit" \
  --property Type=oneshot \
  --property "BindReadOnlyPaths=$src:$dst" \
  /usr/bin/touch "$src/omission-write"

[[ -f "$src/omission-write" ]] || {
  echo 'expected canonical source to stay writable without ReadOnlyPaths (omission proof)' >&2
  exit 1
}

# Two-sided read-only proof: BindReadOnlyPaths + ReadOnlyPaths must make both the
# canonical source and the legacy target non-writable while reads still work.
systemd-run \
  --quiet \
  --wait \
  --collect \
  --unit "$ro_unit" \
  --property Type=oneshot \
  --property "BindReadOnlyPaths=$src:$dst" \
  --property "ReadOnlyPaths=$src" \
  /usr/bin/env bash -c '
    set -e
    test -r "$1/seed" || exit 21
    test -r "$2/seed" || exit 22
    if touch "$1/canonical-write"; then exit 23; fi
    if touch "$2/target-write"; then exit 24; fi
    : > "$3/probe-both-ro-ok"
  ' -- "$src" "$dst" "$tmp"

[[ -f "$tmp/probe-both-ro-ok" ]] || {
  echo 'two-sided read-only namespace was not enforced by effective systemd' >&2
  exit 1
}
[[ ! -e "$src/canonical-write" && ! -e "$dst/target-write" ]] || {
  echo 'read-only namespace unexpectedly allowed a write' >&2
  exit 1
}

# Effective readback: the runtime snapshot/watchdog compares exactly these
# `systemctl show` properties, so an omitted or overridden namespace is a
# visible difference in the effective property set.
: > "$tmp/blocked-marker"
systemd-run \
  --quiet \
  --no-block \
  --collect \
  --unit "$readback_unit" \
  --property Type=exec \
  --property "ReadOnlyPaths=$src" \
  --property "BindReadOnlyPaths=$src:$dst" \
  --property "InaccessiblePaths=$tmp/blocked-marker" \
  /usr/bin/sleep 5
readback_ok=0
for _ in $(seq 1 60); do
  if systemctl show "$readback_unit" -p ReadOnlyPaths -p BindReadOnlyPaths -p InaccessiblePaths >"$tmp/effective.txt" 2>/dev/null; then
    if grep -qE "ReadOnlyPaths=$src" "$tmp/effective.txt" \
      && grep -qE "BindReadOnlyPaths=$src:$dst" "$tmp/effective.txt" \
      && grep -qE "InaccessiblePaths=$tmp/blocked-marker" "$tmp/effective.txt"; then
      readback_ok=1
      break
    fi
  fi
  sleep 0.1
done
systemctl stop "$readback_unit" >/dev/null 2>&1 || true
systemctl reset-failed "$readback_unit" >/dev/null 2>&1 || true
if ((readback_ok != 1)); then
  echo 'effective systemd did not reflect the requested namespace (omission/override not detectable)' >&2
  exit 1
fi

printf '{"ok":true,"hostBind":"read-only","unitBind":"read-write","canonicalSource":"read-only","legacyTarget":"read-only","effectiveReadback":true,"omissionDetectable":true,"persistentUnit":false}\n'
