#!/usr/bin/env bash
# Prepare or verify the persistent ET OCR runtime outside the deployed checkout.
#
# Default/--verify is strictly offline and is safe for systemd ExecStartPre.
# --install is an explicit deployment step: it downloads only hash-locked
# wheels, installs them offline into a versioned venv, verifies the import, and
# atomically switches the `current` symlink. Old versioned venvs are retained
# for rollback; the ET HTTP session is never printed or deleted.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

MODE="verify"
case "${1:-}" in
  ""|--verify) MODE="verify" ;;
  --install) MODE="install" ;;
  *) echo "usage: $0 [--verify|--install]" >&2; exit 64 ;;
esac

RUNTIME_ROOT="$(readlink -m -- "${SHEIN_ET_RUNTIME_ROOT:-/srv/shein-bi/runtime/et-forwarder}")"
LOCK_REQUIREMENTS="${SHEIN_ET_REQUIREMENTS_FILE:-$REPO_ROOT/requirements-et-forwarder.lock}"
RUNTIME_GROUP="${SHEIN_ET_RUNTIME_GROUP:-sheinops}"
BOOTSTRAP_PYTHON="${SHEIN_ET_BOOTSTRAP_PYTHON:-$(command -v python3 || true)}"
LEGACY_SESSION="${SHEIN_ET_LEGACY_SESSION_FILE:-$REPO_ROOT/state/et_forwarder_http_session.local.json}"

SESSION_DIR="$RUNTIME_ROOT/session"
SESSION_FILE="$SESSION_DIR/et_forwarder_http_session.local.json"
VERSIONS_DIR="$RUNTIME_ROOT/venvs"
WHEELHOUSE_ROOT="$RUNTIME_ROOT/wheelhouse"
CURRENT_LINK="$RUNTIME_ROOT/current"
PREPARE_LOCK="$RUNTIME_ROOT/.ensure.lock"

fail() {
  echo "[ensure_et_forwarder_runtime] $1" >&2
  exit 1
}

safe_runtime_path() {
  local raw="$1" resolved
  resolved="$(readlink -m -- "$raw")"
  [[ "$resolved" == "$RUNTIME_ROOT" || "$resolved" == "$RUNTIME_ROOT/"* ]] \
    || fail "refusing path outside runtime root: $raw"
  printf '%s\n' "$resolved"
}

prepare_dir() {
  local dir mode resolved
  dir="$1"
  mode="$2"
  resolved="$(safe_runtime_path "$dir")"
  [[ ! -L "$dir" ]] || fail "refusing symlink directory: $dir"
  if [[ "$(id -u)" -eq 0 ]]; then
    install -d -o root -m "$mode" "$resolved" || fail "cannot prepare directory: $resolved"
    if command -v getent >/dev/null 2>&1 && getent group "$RUNTIME_GROUP" >/dev/null 2>&1; then
      chgrp "$RUNTIME_GROUP" "$resolved" 2>/dev/null || true
    fi
  else
    install -d -m "$mode" "$resolved" || fail "cannot prepare directory: $resolved"
  fi
  [[ -d "$resolved" && ! -L "$resolved" ]] || fail "unsafe directory path: $resolved"
}

[[ "$RUNTIME_ROOT" != "/" ]] || fail "runtime root must not be filesystem root"
[[ -f "$LOCK_REQUIREMENTS" && ! -L "$LOCK_REQUIREMENTS" ]] \
  || fail "locked requirements file missing or unsafe: $LOCK_REQUIREMENTS"
[[ -n "$BOOTSTRAP_PYTHON" ]] || fail "no python3 available for ET runtime verification"

prepare_dir "$RUNTIME_ROOT" 0750
prepare_dir "$SESSION_DIR" 0700
prepare_dir "$VERSIONS_DIR" 0750
prepare_dir "$WHEELHOUSE_ROOT" 0750

if [[ -L "$PREPARE_LOCK" || ( -e "$PREPARE_LOCK" && ! -f "$PREPARE_LOCK" ) ]]; then
  fail "unsafe preparation lock path: $PREPARE_LOCK"
fi
if [[ ! -e "$PREPARE_LOCK" ]]; then
  (umask 077; : >"$PREPARE_LOCK")
fi
chmod 0600 "$PREPARE_LOCK" 2>/dev/null || true
exec 9>>"$PREPARE_LOCK"
flock 9 || fail "cannot acquire ET runtime preparation lock"

LOCK_SHA="$(sha256sum "$LOCK_REQUIREMENTS" | awk '{print $1}')"
[[ "$LOCK_SHA" =~ ^[a-f0-9]{64}$ ]] || fail "cannot hash locked requirements"
VERSION_DIR="$(safe_runtime_path "$VERSIONS_DIR/$LOCK_SHA")"
VERSION_PYTHON="$VERSION_DIR/bin/python"
WHEELHOUSE="$(safe_runtime_path "$WHEELHOUSE_ROOT/$LOCK_SHA")"

verify_version() {
  local python="$1"
  [[ -x "$python" ]] || return 1
  "$python" -c 'import importlib.metadata as m, sys; import ddddocr; sys.exit(0 if sys.prefix != sys.base_prefix and m.version("ddddocr") == "1.6.1" else 1)'
}

probe_python_abi() {
  local python="$1" probe
  [[ -x "$python" ]] || return 1
  probe="$("$python" -c '
import platform, sys
print("|".join([
    platform.python_implementation(),
    f"{sys.version_info[0]}.{sys.version_info[1]}",
    platform.machine().lower(),
    platform.system(),
    platform.libc_ver()[0] or "none",
    platform.libc_ver()[1] or "none",
]))' 2>/dev/null || true)"
  [[ -n "$probe" ]] || return 1
  printf '%s\n' "$probe"
}

verify_python_abi() {
  local python="$1" probe
  probe="$(probe_python_abi "$python")" || {
    echo "[ensure_et_forwarder_runtime] cannot probe interpreter ABI python=$python; current/unit will NOT be switched" >&2
    return 1
  }
  if [[ "$probe" != CPython\|3.12\|x86_64\|Linux\|glibc\|* ]]; then
    echo "[ensure_et_forwarder_runtime] interpreter ABI mismatch python=$python probe=$probe expected=CPython|3.12|x86_64|Linux|glibc; current/unit will NOT be switched" >&2
    return 1
  fi
}

# Authoritative wheel-tag compatibility: parse every downloaded wheel filename
# with packaging.tags/parse_wheel_filename and require each wheel to intersect
# the interpreter's supported tags. If packaging is unavailable in the caller
# environment, fall back to pip's own resolver via an offline --dry-run
# install. Filename pattern guessing is never used.
verify_wheelhouse_compat() {
  local python="$1" wheelhouse="$2" status
  [[ -x "$python" ]] || return 1
  [[ -d "$wheelhouse" ]] || return 1
  if WHEELHOUSE="$wheelhouse" "$python" - <<'PY'
import os, sys
from pathlib import Path
wheelhouse = Path(os.environ.get("WHEELHOUSE", ""))
if not wheelhouse or not wheelhouse.is_dir():
    print("wheelhouse missing", file=sys.stderr)
    sys.exit(2)
try:
    from pip._vendor.packaging.tags import sys_tags
    from pip._vendor.packaging.utils import parse_wheel_filename
except Exception:
    try:
        from packaging.tags import sys_tags
        from packaging.utils import parse_wheel_filename
    except Exception as exc:
        print(f"packaging unavailable: {exc}", file=sys.stderr)
        sys.exit(3)
try:
    supported = set(sys_tags())
    wheels = sorted(wheelhouse.glob("*.whl"))
    if not wheels:
        print("no wheels found", file=sys.stderr)
        sys.exit(2)
    for wheel in wheels:
        _, _, _, tags = parse_wheel_filename(wheel.name)
        if not (set(tags) & supported):
            print(f"incompatible wheel: {wheel.name}", file=sys.stderr)
            sys.exit(1)
except Exception as exc:
    print(f"wheel tag validation failed: {exc}", file=sys.stderr)
    sys.exit(2)
print(f"verified {len(wheels)} wheels against {len(supported)} supported tags")
PY
  then
    return 0
  else
    status=$?
  fi
  if (( status == 3 )); then
    echo "[ensure_et_forwarder_runtime] packaging.tags unavailable; falling back to offline pip dry-run compatibility check" >&2
    if "$python" -m pip install --dry-run --no-index --find-links "$wheelhouse" \
      --require-hashes --only-binary=:all: \
      --disable-pip-version-check --no-input \
      -r "$LOCK_REQUIREMENTS" >/dev/null 2>&1; then
      return 0
    fi
  fi
  echo "[ensure_et_forwarder_runtime] wheelhouse compatibility check failed python=$python wheelhouse=$wheelhouse; current/unit will NOT be switched" >&2
  return 1
}

activate_version() {
  local tmp_link="$RUNTIME_ROOT/.current.$$"
  safe_runtime_path "$tmp_link" >/dev/null
  rm -f -- "$tmp_link"
  ln -s -- "$VERSION_DIR" "$tmp_link" || fail "cannot create current runtime symlink"
  mv -Tf -- "$tmp_link" "$CURRENT_LINK" || {
    rm -f -- "$tmp_link"
    fail "cannot atomically activate ET runtime"
  }
}

install_version() {
  local wheel_tmp="$WHEELHOUSE.tmp.$$"
  safe_runtime_path "$wheel_tmp" >/dev/null
  [[ ! -L "$VERSION_DIR" ]] || fail "refusing symlink version directory: $VERSION_DIR"
  [[ ! -L "$WHEELHOUSE" ]] || fail "refusing symlink wheelhouse: $WHEELHOUSE"
  verify_python_abi "$BOOTSTRAP_PYTHON" \
    || fail "bootstrap interpreter ABI mismatch; current/unit will NOT be switched"

  if [[ ! -d "$WHEELHOUSE" ]]; then
    rm -rf -- "$wheel_tmp"
    install -d -m 0750 "$wheel_tmp"
    "$BOOTSTRAP_PYTHON" -m pip download \
      --disable-pip-version-check --no-input --progress-bar off \
      --require-hashes --only-binary=:all: \
      --dest "$wheel_tmp" -r "$LOCK_REQUIREMENTS" \
      || { rm -rf -- "$wheel_tmp"; fail "hash-locked wheel download failed"; }
    mv -- "$wheel_tmp" "$WHEELHOUSE" \
      || { rm -rf -- "$wheel_tmp"; fail "cannot activate ET wheelhouse"; }
  fi

  verify_wheelhouse_compat "$BOOTSTRAP_PYTHON" "$WHEELHOUSE" \
    || fail "downloaded wheels are incompatible with the bootstrap interpreter; current/unit will NOT be switched"

  if ! verify_version "$VERSION_PYTHON"; then
    [[ ! -e "$VERSION_DIR" ]] || rm -rf -- "$VERSION_DIR"
    "$BOOTSTRAP_PYTHON" -m venv "$VERSION_DIR" \
      || { rm -rf -- "$VERSION_DIR"; fail "versioned venv creation failed"; }
    verify_python_abi "$VERSION_PYTHON" \
      || { rm -rf -- "$VERSION_DIR"; fail "versioned venv interpreter ABI mismatch; current/unit will NOT be switched"; }
    verify_wheelhouse_compat "$VERSION_PYTHON" "$WHEELHOUSE" \
      || { rm -rf -- "$VERSION_DIR"; fail "downloaded wheels are incompatible with the versioned venv; current/unit will NOT be switched"; }
    "$VERSION_PYTHON" -m pip install \
      --disable-pip-version-check --no-input --progress-bar off \
      --no-index --find-links "$WHEELHOUSE" \
      --require-hashes --only-binary=:all: \
      -r "$LOCK_REQUIREMENTS" \
      || { rm -rf -- "$VERSION_DIR"; fail "offline hash-locked install failed"; }
    verify_version "$VERSION_PYTHON" \
      || { rm -rf -- "$VERSION_DIR"; fail "ddddocr verification failed in versioned venv"; }
    chmod -R a-st,go-w "$VERSION_DIR"
  fi

  [[ ! -L "$SESSION_FILE" ]] || fail "refusing symlink ET session path; current/unit will NOT be switched"
  if [[ ! -e "$SESSION_FILE" && -f "$LEGACY_SESSION" && ! -L "$LEGACY_SESSION" ]]; then
    install -m 0600 "$LEGACY_SESSION" "$SESSION_FILE" \
      || fail "cannot copy legacy ET session into persistent runtime"
  fi
  activate_version
}

verify_python_abi "$BOOTSTRAP_PYTHON" \
  || fail "bootstrap interpreter ABI mismatch; current/unit will NOT be switched"

if [[ "$MODE" == "install" ]]; then
  install_version
fi

[[ -L "$CURRENT_LINK" ]] || fail "ET runtime is not installed; run $0 --install during deployment"
CURRENT_TARGET="$(readlink -f -- "$CURRENT_LINK" 2>/dev/null || true)"
[[ "$CURRENT_TARGET" == "$VERSION_DIR" ]] \
  || fail "ET runtime lock mismatch; run $0 --install during deployment"
verify_python_abi "$CURRENT_LINK/bin/python" \
  || fail "ET runtime Python ABI mismatch; current/unit will NOT be switched"
verify_version "$CURRENT_LINK/bin/python" \
  || fail "ET runtime verification failed; system python will NOT be used"

if [[ -f "$SESSION_FILE" ]]; then
  chmod 0600 "$SESSION_FILE" 2>/dev/null || true
fi

echo "[ensure_et_forwarder_runtime] ready mode=$MODE lock_sha=$LOCK_SHA python=$CURRENT_LINK/bin/python ddddocr=1.6.1"
