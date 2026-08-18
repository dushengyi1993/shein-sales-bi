#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${SHEIN_BI_BACKUP_ROOT:-/srv/shein-bi/backups/auto}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"
RETENTION_DAYS="${SHEIN_BI_BACKUP_RETENTION_DAYS:-7}"
COS_MOUNT="${SHEIN_BI_BACKUP_COS_MOUNT:-/lhcos-data}"
COS_ARCHIVE_ROOT="${SHEIN_BI_BACKUP_COS_ARCHIVE_ROOT:-$COS_MOUNT/shein-bi-db-backups}"
MANUAL_LIMITED_DISCOUNT_REGISTRY="${SHEIN_BI_MANUAL_LIMITED_DISCOUNT_REGISTRY:-/srv/shein-bi/runtime/marketing_manual_limited_discount_overrides.json}"
BROWSER_STATE_BACKUP_ENABLED="${SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED:-1}"
BROWSER_STATE_BACKUP_KEY_FILE="${SHEIN_BI_BROWSER_STATE_BACKUP_KEY_FILE:-/srv/shein-bi/secrets/browser-state-backup.key}"
BROWSER_PROFILE_ROOT="${SHEIN_BI_BROWSER_PROFILE_ROOT:-/data/shein-bi/profiles}"
BROWSER_SESSION_ROOT="${SHEIN_BI_BROWSER_SESSION_ROOT:-/data/shein-bi/state/shein_webapi_sessions}"
BROWSER_STATE_LIMIT_TOTAL_BYTES="${SHEIN_BI_BROWSER_STATE_LIMIT_TOTAL_BYTES:-8g}"
PYTHON_BIN="${SHEIN_BI_BACKUP_PYTHON:-python3}"
# Independent remote-object verifier (see verify_independent_remote).  Empty by
# default: without a configured verifier the local-deletion gate fails closed,
# so the archive stays on the remote FUSE path and the verified local copy is
# preserved.
SHEIN_BI_REMOTE_VERIFY_CMD="${SHEIN_BI_REMOTE_VERIFY_CMD:-}"
# Remote persistence is completed inside this one service invocation.  Retry
# attempts stay in the foreground while run_host_heavy_job.sh continues to hold
# the exclusive host/project/domain locks.  74 is an exhausted I/O gate and 78
# is a non-retryable verifier configuration error; neither is SuccessExitStatus
# 75 in the existing unit.
SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS="${SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS:-3}"
SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC="${SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC:-30}"
SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC="${SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC:-600}"
SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC="${SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC:-5}"
REMOTE_VERIFY_HARD_MAX_ATTEMPTS=10
REMOTE_VERIFY_HARD_MAX_INTERVAL_SEC=3600
REMOTE_VERIFY_HARD_MAX_TIMEOUT_SEC=600
REMOTE_VERIFY_HARD_MAX_KILL_AFTER_SEC=60
REMOTE_VERIFY_MAX_OUTPUT_BYTES=512
REMOTE_VERIFY_EXHAUSTED_STATUS=74
REMOTE_VERIFY_CONFIG_STATUS=78
# Freshness window for abandoned .pending-* staging cleanup (minutes).
SHEIN_BI_BACKUP_STALE_STAGING_MINUTES="${SHEIN_BI_BACKUP_STALE_STAGING_MINUTES:-30}"
RETENTION_HARD_MAX_DAYS=3650
STALE_STAGING_HARD_MAX_MINUTES=10080
MAX_DECIMAL_CONFIG_DIGITS=10
# Application root used to locate the encrypted browser-state tool.
SHEIN_BI_APP_DIR="${SHEIN_BI_APP_DIR:-/opt/shein-bi/app}"
MANAGE_BROWSER_STATE="$SHEIN_BI_APP_DIR/scripts/manage_encrypted_browser_state_backup.mjs"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
OUT_DIR="$BACKUP_ROOT/$STAMP"
OUT_STAGING="$BACKUP_ROOT/.pending-$STAMP-$$"
STAGING_PUBLISHED=0

PRUNE_ONLY=0
TEST_ARCHIVE_SOURCE=""
TEST_ARCHIVE_REMOVE_AFTER="0"
TEST_RECEIPT_FILE=""
TEST_STAGING_CLEANUP=0
TEST_STAGING_TRAP=0
while (( $# > 0 )); do
  case "$1" in
    --prune-only)
      PRUNE_ONLY=1
      shift
      ;;
    --test-archive-verified)
      [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" == "1" && $# -eq 3 ]] || {
        echo "--test-archive-verified is restricted to SHEIN_BI_BACKUP_TEST_MODE=1" >&2
        exit 64
      }
      TEST_ARCHIVE_SOURCE="$2"
      TEST_ARCHIVE_REMOVE_AFTER="$3"
      shift 3
      ;;
    --test-check-receipt)
      [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" == "1" && $# -eq 2 ]] || {
        echo "--test-check-receipt is restricted to SHEIN_BI_BACKUP_TEST_MODE=1" >&2
        exit 64
      }
      TEST_RECEIPT_FILE="$2"
      shift 2
      ;;
    --test-staging-cleanup)
      [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" == "1" && $# -eq 1 ]] || {
        echo "--test-staging-cleanup is restricted to SHEIN_BI_BACKUP_TEST_MODE=1" >&2
        exit 64
      }
      TEST_STAGING_CLEANUP=1
      shift
      ;;
    --test-staging-trap)
      [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" == "1" && $# -eq 1 ]] || {
        echo "--test-staging-trap is restricted to SHEIN_BI_BACKUP_TEST_MODE=1" >&2
        exit 64
      }
      TEST_STAGING_TRAP=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 64
      ;;
  esac
done

normalize_bounded_decimal_config() {
  local target="$1" raw="$2" minimum="$3" maximum="$4" label="$5" normalized
  # Never place an operator-controlled string in arithmetic context until it
  # has been proved to contain only a short ASCII decimal.  This blocks Bash
  # arithmetic-expression/array-subscript evaluation through environment
  # values while also avoiding octal interpretation of leading zeroes.
  if [[ ! "$raw" =~ ^[0-9]+$ ]] || [[ ${#raw} -gt $MAX_DECIMAL_CONFIG_DIGITS ]]; then
    echo "[cloud_db_backup] invalid $label; expected decimal $minimum..$maximum" >&2
    return 64
  fi
  normalized=$((10#$raw))
  if (( normalized < minimum || normalized > maximum )); then
    echo "[cloud_db_backup] invalid $label; expected decimal $minimum..$maximum" >&2
    return 64
  fi
  printf -v "$target" '%d' "$normalized"
}

validate_numeric_config() {
  normalize_bounded_decimal_config RETENTION_DAYS "$RETENTION_DAYS" 1 "$RETENTION_HARD_MAX_DAYS" SHEIN_BI_BACKUP_RETENTION_DAYS || return $?
  normalize_bounded_decimal_config SHEIN_BI_BACKUP_STALE_STAGING_MINUTES "$SHEIN_BI_BACKUP_STALE_STAGING_MINUTES" 1 "$STALE_STAGING_HARD_MAX_MINUTES" SHEIN_BI_BACKUP_STALE_STAGING_MINUTES || return $?
  normalize_bounded_decimal_config SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS "$SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS" 1 "$REMOTE_VERIFY_HARD_MAX_ATTEMPTS" SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS || return $?
  normalize_bounded_decimal_config SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC "$SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC" 0 "$REMOTE_VERIFY_HARD_MAX_INTERVAL_SEC" SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC || return $?
  normalize_bounded_decimal_config SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC "$SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC" 1 "$REMOTE_VERIFY_HARD_MAX_TIMEOUT_SEC" SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC || return $?
  normalize_bounded_decimal_config SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC "$SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC" 1 "$REMOTE_VERIFY_HARD_MAX_KILL_AFTER_SEC" SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC || return $?
}
validate_numeric_config || exit $?

cos_ready() {
  local probe
  mountpoint -q "$COS_MOUNT" || return 1
  [[ -d "$COS_MOUNT" && -w "$COS_MOUNT" ]] || return 1
  probe="$COS_MOUNT/.shein-bi-db-backup-probe-$STAMP-$$"
  printf 'probe %s\n' "$STAMP" > "$probe" || return 1
  [[ -s "$probe" ]] || return 1
  rm -f -- "$probe"
}

wait_for_cos_ready_with_retry() {
  local attempt
  for (( attempt = 1; attempt <= SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS; attempt++ )); do
    echo "[cloud_db_backup] offsite-ready attempt=$attempt/$SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS"
    if cos_ready; then
      return 0
    fi
    if (( attempt < SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS )); then
      echo "[cloud_db_backup] offsite-ready retry-scheduled next_attempt=$(( attempt + 1 )) interval_sec=$SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC" >&2
      if (( SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC > 0 )); then
        sleep "$SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC"
      fi
    fi
  done
  echo "[cloud_db_backup] offsite-ready terminal=exhausted attempts=$SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS status=$REMOTE_VERIFY_EXHAUSTED_STATUS local-preserved=1" >&2
  return "$REMOTE_VERIFY_EXHAUSTED_STATUS"
}

# Validate the authenticated create receipt before any further stage runs.
# Both roots must be present and no root may have been skipped: a bare
# optional-source skip would otherwise let the backup complete without
# session state and the offsite/delete chain would later trust it.
verify_browser_state_receipt() {
  local receipt="$1"
  [[ -n "$receipt" && -f "$receipt" && -s "$receipt" ]] || {
    echo "[cloud_db_backup] browser-state create receipt missing or empty: $receipt" >&2
    return 1
  }
  BROWSER_RECEIPT_FILE="$receipt" node - <<'NODE'
const fs = require('node:fs');
const file = process.env.BROWSER_RECEIPT_FILE;
let receipt;
try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) { console.error('browser-state receipt is not valid JSON'); process.exit(1); }
if (receipt.ok !== true || receipt.action !== 'create') { console.error('browser-state create did not complete'); process.exit(1); }
const roots = Array.isArray(receipt.includedRoots) ? receipt.includedRoots : [];
if (!roots.includes('profiles') || !roots.includes('state/shein_webapi_sessions')) {
  console.error('browser-state create omitted a required root: ' + JSON.stringify(roots));
  process.exit(1);
}
if (Array.isArray(receipt.skippedOptionalRoots) && receipt.skippedOptionalRoots.length !== 0) {
  console.error('browser-state create skipped required state roots: ' + receipt.skippedOptionalRoots.join(','));
  process.exit(1);
}
NODE
}

# Bounded housekeeping: abandoned .pending-* staging directories from a
# previous crashed run are removed once older than the freshness window, so
# repeated failures cannot fill the disk.  The current run's staging is not
# stale; it is removed by the EXIT trap instead.
cleanup_stale_staging() {
  local now old stale mtime removed=0
  now="$(date +%s)"
  old=$(( now - SHEIN_BI_BACKUP_STALE_STAGING_MINUTES * 60 ))
  while IFS= read -r -d '' stale; do
    [[ -d "$stale" ]] || continue
    mtime="$(date -r "$stale" +%s 2>/dev/null || echo 0)"
    if (( mtime < old )); then
      rm -rf -- "$stale" || return 1
      removed=$(( removed + 1 ))
    fi
  done < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.pending-*' -print0 2>/dev/null || true)
  echo "[cloud_db_backup] stale staging removed=$removed"
}

cleanup_current_staging() {
  if [[ "$STAGING_PUBLISHED" == "0" && -n "$OUT_STAGING" && -d "$OUT_STAGING" ]]; then
    rm -rf -- "$OUT_STAGING" || true
  fi
}
trap cleanup_current_staging EXIT

# Bind the persistent identity of the COS destination directory so an object
# is published and later deleted only while the mount still resolves to the
# same canonical path, device/inode and filesystem.  A remount or path
# redirection breaks the binding and the local deletion gate fails closed.
capture_dir_identity() {
  local dir="$1" canon devino fstype
  canon="$(realpath -e -- "$dir" 2>/dev/null)" || return 1
  devino="$(stat -c '%d:%i' -- "$canon" 2>/dev/null)" || return 1
  fstype="$(findmnt -no FSTYPE --target "$canon" 2>/dev/null || findmnt -no FSTYPE --target "$dir" 2>/dev/null || echo unknown)"
  printf '%s|%s|%s\n' "$canon" "$devino" "$fstype" | sha256sum | cut -d' ' -f1
}

# Independent remote-object verification contract:
#   "$SHEIN_BI_REMOTE_VERIFY_CMD" "<archive_day>/<base>.tar" <sha256> <size>
# The verifier must independently confirm the object is durably present at
# the remote side (not through the local FUSE mount) and print ABSOLUTELY
# EXACTLY one line "remote-ok <sha256> <size>".  Leading noise, trailing
# blank lines, a missing newline, or any other bytes fail the byte-exact
# comparison.  Reading the same FUSE path back is NOT independent persistence
# proof and is never substituted here.  Without a configured verifier the
# delete gate fails closed and the local copy is preserved.
verify_independent_remote() {
  local rel="$1" digest="$2" size="$3" command_status
  local out_file="" expected_file="" out_size=""
  if [[ -z "$SHEIN_BI_REMOTE_VERIFY_CMD" ]]; then
    echo "[cloud_db_backup] independent remote verifier not configured; persistence gate fails closed reason=remote-verifier-missing" >&2
    return "$REMOTE_VERIFY_CONFIG_STATUS"
  fi
  if [[ ! -x "$SHEIN_BI_REMOTE_VERIFY_CMD" ]]; then
    echo "[cloud_db_backup] independent remote verifier is not executable; persistence gate fails closed reason=remote-verifier-not-executable" >&2
    return "$REMOTE_VERIFY_CONFIG_STATUS"
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    echo "[cloud_db_backup] GNU timeout unavailable; persistence gate fails closed reason=remote-verifier-timeout-unavailable" >&2
    return "$REMOTE_VERIFY_CONFIG_STATUS"
  fi
  if ! out_file="$(mktemp "${BACKUP_ROOT}/.remote-verify-out.XXXXXX")" ||
     ! expected_file="$(mktemp "${BACKUP_ROOT}/.remote-verify-expected.XXXXXX")"; then
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification staging unavailable rel=$rel" >&2
    return 1
  fi
  # The verifier remains a synchronous foreground child under the outer
  # host/project/domain locks.  TERM is followed by a hard KILL after the
  # separately bounded grace period.  stdout is captured through a hard byte
  # cap so a flooding verifier can never exhaust the service disk, and stderr
  # is never copied to service logs; only the byte-exact contract line is
  # inspected.
  if timeout --foreground --signal=TERM \
      --kill-after="${SHEIN_BI_REMOTE_VERIFY_KILL_AFTER_SEC}s" \
      -- "${SHEIN_BI_REMOTE_VERIFY_TIMEOUT_SEC}s" \
      "$SHEIN_BI_REMOTE_VERIFY_CMD" "$rel" "$digest" "$size" 2>/dev/null |
      { head -c "$REMOTE_VERIFY_MAX_OUTPUT_BYTES" > "$out_file"; }; then
    command_status=0
  else
    command_status=$?
  fi
  if (( command_status == REMOTE_VERIFY_CONFIG_STATUS )); then
    # In-verifier configuration failures (missing credentials, locked-target
    # drift, unsafe key) are distinct from retryable I/O and stop immediately:
    # a 78 is terminal and must never be downgraded to 1/74 even when the
    # verifier also emitted noisy stdout.
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification terminal=config-error verifier_status=$REMOTE_VERIFY_CONFIG_STATUS rel=$rel" >&2
    return "$REMOTE_VERIFY_CONFIG_STATUS"
  fi
  if ! out_size="$(stat -c %s -- "$out_file" 2>/dev/null)"; then
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification output unreadable rel=$rel" >&2
    return 1
  fi
  # A captured length at the hard cap is always a flood, even if the
  # verifier happened to exit zero before the pipe was cut.
  if (( out_size >= REMOTE_VERIFY_MAX_OUTPUT_BYTES )); then
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification rejected rel=$rel reason=remote-verifier-output-flood" >&2
    return 1
  fi

  if (( command_status != 0 )); then
    # Verifier output is deliberately not copied to the service log: a
    # provider CLI may include credentials or signed endpoints in diagnostics.
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification failed rel=$rel verifier_status=$command_status" >&2
    return 1
  fi
  # Byte-exact comparison; tail-based parsing is never used.  The captured
  # stdout must equal exactly "remote-ok <sha256> <size>\n".
  printf '%s\n' "remote-ok $digest $size" > "$expected_file"
  if ! cmp -s -- "$out_file" "$expected_file"; then
    rm -f -- "$out_file" "$expected_file"
    echo "[cloud_db_backup] independent remote verification mismatch rel=$rel" >&2
    return 1
  fi
  rm -f -- "$out_file" "$expected_file"
  return 0
}
verify_independent_remote_with_retry() {
  local rel="$1" digest="$2" size="$3" phase="${4:-post-publish}" attempt status
  # Calls are foreground and serial.  The parent service retains the same
  # exclusive locks across every attempt; no recursive service/script launch
  # and no background verifier can overlap an attempt.
  for (( attempt = 1; attempt <= SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS; attempt++ )); do
    echo "[cloud_db_backup] remote-verify phase=$phase attempt=$attempt/$SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS rel=$rel"
    if verify_independent_remote "$rel" "$digest" "$size"; then
      echo "[cloud_db_backup] remote-verify phase=$phase terminal=confirmed attempt=$attempt rel=$rel"
      return 0
    else
      status=$?
    fi
    if (( status == REMOTE_VERIFY_CONFIG_STATUS )); then
      echo "[cloud_db_backup] remote-verify phase=$phase terminal=config-error attempt=$attempt status=$REMOTE_VERIFY_CONFIG_STATUS rel=$rel local-preserved=1" >&2
      return "$REMOTE_VERIFY_CONFIG_STATUS"
    fi
    if (( attempt < SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS )); then
      echo "[cloud_db_backup] remote-verify phase=$phase retry-scheduled next_attempt=$(( attempt + 1 )) interval_sec=$SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC rel=$rel" >&2
      if (( SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC > 0 )); then
        sleep "$SHEIN_BI_REMOTE_VERIFY_RETRY_INTERVAL_SEC"
      fi
    fi
  done
  echo "[cloud_db_backup] remote-verify phase=$phase terminal=exhausted attempts=$SHEIN_BI_REMOTE_VERIFY_MAX_ATTEMPTS status=$REMOTE_VERIFY_EXHAUSTED_STATUS rel=$rel local-preserved=1" >&2
  return "$REMOTE_VERIFY_EXHAUSTED_STATUS"
}
validate_local_backup() {
  local source_dir
  source_dir="$1"
  if ! "$PYTHON_BIN" - "$source_dir" <<'PY'
import hashlib
import os
from pathlib import Path
import re
import stat
import sys

root = Path(sys.argv[1])
manifest_path = root / "SHA256SUMS.txt"
portable_name = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
manifest_line = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$")

try:
    raw = manifest_path.read_bytes()
    text = raw.decode("ascii")
except (OSError, UnicodeDecodeError) as error:
    raise SystemExit(f"invalid checksum manifest: {error}")

if not text or not text.endswith("\n"):
    raise SystemExit("checksum manifest must be non-empty and newline-terminated")

expected = {}
for line in text.splitlines():
    match = manifest_line.fullmatch(line)
    if not match:
        raise SystemExit(f"unsafe or malformed checksum line: {line!r}")
    digest, name = match.groups()
    if not portable_name.fullmatch(name) or name == "SHA256SUMS.txt":
        raise SystemExit(f"unsafe checksum path: {name!r}")
    if name in expected:
        raise SystemExit(f"duplicate checksum path: {name!r}")
    expected[name] = digest

actual = {}
for entry in os.scandir(root):
    if entry.name == "SHA256SUMS.txt":
        if not stat.S_ISREG(entry.stat(follow_symlinks=False).st_mode):
            raise SystemExit("checksum manifest is not a regular file")
        continue
    if not portable_name.fullmatch(entry.name):
        raise SystemExit(f"unsafe local backup path: {entry.name!r}")
    mode = entry.stat(follow_symlinks=False).st_mode
    if not stat.S_ISREG(mode):
        raise SystemExit(f"local backup entry is not a regular file: {entry.name!r}")
    actual[entry.name] = None

if set(actual) != set(expected):
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    raise SystemExit(f"local backup inventory mismatch missing={missing!r} extra={extra!r}")
PY
  then
    return 1
  fi
  (
    cd "$source_dir"
    sha256sum -c -- SHA256SUMS.txt >/dev/null
  ) || return 1
}

verify_archive_payload() {
  local archive base local_manifest
  archive="$1"
  base="$2"
  local_manifest="$3"
  "$PYTHON_BIN" - "$archive" "$base" "$local_manifest" <<'PY'
import hashlib
import os
from pathlib import Path
import re
import stat
import sys
import tarfile

archive_path, base, local_manifest_path = sys.argv[1:]
portable_name = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
manifest_line = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$")

if not portable_name.fullmatch(base):
    raise SystemExit(f"unsafe archive root: {base!r}")

try:
    local_manifest = Path(local_manifest_path).read_bytes()
    manifest_text = local_manifest.decode("ascii")
except (OSError, UnicodeDecodeError) as error:
    raise SystemExit(f"invalid local manifest: {error}")

expected = {}
for line in manifest_text.splitlines():
    match = manifest_line.fullmatch(line)
    if not match:
        raise SystemExit(f"unsafe or malformed checksum line: {line!r}")
    digest, name = match.groups()
    if name == "SHA256SUMS.txt" or name in expected:
        raise SystemExit(f"invalid or duplicate checksum path: {name!r}")
    expected[name] = digest

source_root = Path(local_manifest_path).parent
expected_sizes = {}
for name in expected:
    source = source_root / name
    try:
        source_stat = source.stat(follow_symlinks=False)
    except OSError as error:
        raise SystemExit(f"cannot stat verified local member {name!r}: {error}")
    if not stat.S_ISREG(source_stat.st_mode):
        raise SystemExit(f"verified local member is not a regular file: {name!r}")
    expected_sizes[name] = source_stat.st_size
flags = os.O_RDONLY
if hasattr(os, "O_CLOEXEC"):
    flags |= os.O_CLOEXEC
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW

try:
    descriptor = os.open(archive_path, flags)
except OSError as error:
    raise SystemExit(f"cannot safely open archive: {error}")

with os.fdopen(descriptor, "rb", closefd=True) as archive_file:
    before = os.fstat(archive_file.fileno())
    archive_digest = hashlib.sha256()
    while chunk := archive_file.read(1024 * 1024):
        archive_digest.update(chunk)
    archive_file.seek(0)

    try:
# r: auto-detects compression: the archive is a store tar so already-
# compressed dump members are never gzipped a second time.
        bundle = tarfile.open(fileobj=archive_file, mode="r:")
    except (tarfile.TarError, OSError) as error:
        raise SystemExit(f"invalid gzip/tar archive: {error}")

    seen = set()
    members = {}
    with bundle:
        for member in bundle:
            name = member.name
            if name in seen:
                raise SystemExit(f"duplicate archive entry: {name!r}")
            seen.add(name)
            if name == base:
                if not member.isdir():
                    raise SystemExit("archive root is not a directory")
                continue
            prefix = f"{base}/"
            if not name.startswith(prefix):
                raise SystemExit(f"archive path escapes expected root: {name!r}")
            relative = name[len(prefix):]
            if not portable_name.fullmatch(relative):
                raise SystemExit(f"unsafe or nested archive path: {name!r}")
            if not member.isreg():
                raise SystemExit(f"archive entry is not a regular file: {name!r}")
            members[relative] = member

        if base not in seen:
            raise SystemExit("archive root directory entry is missing")
        required = set(expected) | {"SHA256SUMS.txt"}
        if set(members) != required:
            missing = sorted(required - set(members))
            extra = sorted(set(members) - required)
            raise SystemExit(f"archive inventory mismatch missing={missing!r} extra={extra!r}")

        manifest_stream = bundle.extractfile(members["SHA256SUMS.txt"])
        if members["SHA256SUMS.txt"].size != len(local_manifest):
            raise SystemExit("archive checksum manifest size differs from verified local manifest")
        if manifest_stream is None or manifest_stream.read(len(local_manifest) + 1) != local_manifest:
            raise SystemExit("archive checksum manifest differs from verified local manifest")

        for name, expected_digest in expected.items():
            if members[name].size != expected_sizes[name]:
                raise SystemExit(f"archive member size mismatch: {name!r}")
            stream = bundle.extractfile(members[name])
            if stream is None:
                raise SystemExit(f"cannot read archive member: {name!r}")
            digest = hashlib.sha256()
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
            if digest.hexdigest() != expected_digest:
                raise SystemExit(f"archive member checksum mismatch: {name!r}")

    after = os.fstat(archive_file.fileno())
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
        raise SystemExit("archive changed while it was being verified")

print(archive_digest.hexdigest())
PY
}

# Local-deletion parent security.  The quarantine/delete sequence is only as
# strong as its parent directory: if the retention root were writable by
# group or other, an attacker with such write access could rename the unique
# quarantine away or re-swap the source path after final verification.  The
# gate requires a root-owned parent with group/other non-writable bits
# (mode & 0o022 == 0) and otherwise fails closed, preserving every local and
# quarantined artifact.  The Windows contract fixtures cannot be root-owned,
# so the bypass below is honoured only when SHEIN_BI_BACKUP_TEST_MODE=1; in
# production the flag is never set and the bypass is inert.
verify_delete_parent_secure() {
  local dir="$1" owner mode
  if [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" == "1" &&
        "${SHEIN_BI_BACKUP_TEST_ALLOW_INSECURE_DELETE_PARENT:-0}" == "1" ]]; then
    return 0
  fi
  owner="$(stat -c %u -- "$dir" 2>/dev/null)" || return 1
  mode="$(stat -c %a -- "$dir" 2>/dev/null)" || return 1
  [[ "$owner" =~ ^[0-9]+$ && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  # Explicit octal bases: stat-derived strings never enter a decimal or
  # unguarded arithmetic context.
  if (( owner != 0 )) || (( ( 8#$mode & 8#22 ) != 0 )); then
    return 1
  fi
  return 0
}

# Test-only path-swap hook -- after-final-identity-before-quarantine.
# SHEIN_BI_BACKUP_TEST_MODE=1 combined with
# SHEIN_BI_BACKUP_TEST_SWAP_AFTER_FINAL_IDENTITY=1 simulates an attacker
# swapping the deletion candidate for an identical-content clone exactly
# between the final identity gate and the quarantine rename.  The script must
# then quarantine first, detect the fresh inode during re-verification, keep
# the quarantine and never delete either the original or the replacement.  In
# production (test mode unset) this function is a strict no-op.
after_final_identity_before_quarantine() {
  local current="$1"
  if [[ "${SHEIN_BI_BACKUP_TEST_MODE:-0}" != "1" ||
        "${SHEIN_BI_BACKUP_TEST_SWAP_AFTER_FINAL_IDENTITY:-0}" != "1" ]]; then
    return 0
  fi
  [[ -n "$current" && -d "$current" ]] || {
    echo "[cloud_db_backup] test path-swap hook refused source=$current" >&2
    return 1
  }
  mv -- "$current" "$current.swap-orig" || return 1
  cp -a -- "$current.swap-orig" "$current" || return 1
}

archive_verified() {
  local source_dir source_real root_real remove_after base archive_day archive_dir archive partial checksum checksum_partial archive_digest local_manifest_digest current_manifest_digest remote_size remote_status stored_id current_id rel partial_identity mount_id mount_id_partial final_source_real source_identity published_new=0 quarantine quarantine_identity quarantined_manifest_digest
  source_dir="$1"
  remove_after="${2:-0}"
  [[ "$remove_after" == "0" || "$remove_after" == "1" ]] || return 64
  if ! root_real="$(realpath -e -- "$BACKUP_ROOT")" ||
     ! source_real="$(realpath -e -- "$source_dir")"; then
    echo "[cloud_db_backup] refuse unresolved retention path=$source_dir" >&2
    return 73
  fi
  if [[ -L "$source_dir" || "$(dirname "$source_real")" != "$root_real" ]]; then
    echo "[cloud_db_backup] refuse non-direct retention path=$source_dir" >&2
    return 73
  fi
  source_dir="$source_real"
  base="$(basename "$source_dir")"
  [[ "$base" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && -d "$source_dir" ]] || {
    echo "[cloud_db_backup] refuse unsafe retention path=$source_dir" >&2
    return 73
  }
  [[ -s "$source_dir/SHA256SUMS.txt" ]] || {
    echo "[cloud_db_backup] keep unverified backup=$source_dir reason=missing-checksums" >&2
    return 1
  }
  if ! validate_local_backup "$source_dir"; then
    echo "[cloud_db_backup] keep unverified backup=$source_dir reason=unsafe-or-invalid-local-backup" >&2
    return 1
  fi
  if ! local_manifest_digest="$(sha256sum -- "$source_dir/SHA256SUMS.txt" | awk '{print $1}')"; then
    echo "[cloud_db_backup] keep unverified backup=$source_dir reason=manifest-digest-unavailable" >&2
    return 1
  fi
  # Bind the canonical source directory identity after the first full local
  # verification so the final delete gate can reject a path swap or inode
  # replacement that happened across the slow remote readbacks below.
  if ! source_identity="$(stat -c '%d:%i' -- "$source_dir")"; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=source-identity-unbound" >&2
    return 1
  fi

  if ! archive_day="$(TZ="$TZ_NAME" date -r "$source_dir" +%Y-%m-%d)"; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=archive-date-unavailable" >&2
    return 1
  fi
  archive_dir="$COS_ARCHIVE_ROOT/$archive_day"  # Store tar: the pg_dump members are already compressed (pg_dump -Fc), so a
  # second gzip pass would only re-compress already-compressed large files.
  archive="$archive_dir/$base.tar"
  partial="$archive_dir/.$base.tar.partial-$STAMP-$$"
  checksum="$archive.sha256"
  checksum_partial="$archive_dir/.$base.tar.sha256.partial-$STAMP-$$"
  mount_id="$archive.mount-id"
  mount_id_partial="$archive_dir/.$base.tar.mount-id.partial-$STAMP-$$"
  if ! mkdir -p "$archive_dir" || ! rm -f -- "$partial" "$checksum_partial" "$mount_id_partial"; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-staging-unavailable" >&2
    return 1
  fi
  # Bind the expected COS destination identity before any publish or delete.
  current_id="$(capture_dir_identity "$archive_dir")" || {
    echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-unbound" >&2
    return 1
  }

  if [[ ! -s "$archive" ]]; then
    if ! tar -C "$root_real" -cf "$partial" "$base"; then
      rm -f -- "$partial" "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-archive-create-failed" >&2
      return 1
    fi
    if ! archive_digest="$(verify_archive_payload "$partial" "$base" "$source_dir/SHA256SUMS.txt")"; then
      rm -f -- "$partial" "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=new-offsite-archive-content-invalid" >&2
      return 1
    fi
    partial_identity="$(stat -c '%d:%i' -- "$partial")" || partial_identity=""
    if ! mv -- "$partial" "$archive"; then
      rm -f -- "$partial" "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-archive-publish-failed" >&2
      return 1
    fi
    # mv is an atomic same-filesystem rename: the published inode must be the
    # very inode verified above, and the digest is already known from that
    # single verification read (no second full-size FUSE read is needed).
    if [[ -n "$partial_identity" && "$(stat -c '%d:%i' -- "$archive" 2>/dev/null)" != "$partial_identity" ]]; then
      rm -f -- "$archive" "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-archive-inode-drift" >&2
      return 1
    fi
    published_new=1
  else
    # A pre-existing remote object must be re-verified in full every time; it
    # is never trusted from a sidecar alone.
    if ! archive_digest="$(verify_archive_payload "$archive" "$base" "$source_dir/SHA256SUMS.txt")"; then
      rm -f -- "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-archive-content-invalid" >&2
      return 1
    fi
  fi

  # Publish-time mount identity.  The historical binding is written only
  # when this run just PUBLISHED a new object; an existing object keeps its
  # original binding so a later delete run compares against it.  A remount
  # or path redirection therefore breaks the chain fails closed.
  if [[ "$published_new" == "1" ]]; then
    if [[ "$(capture_dir_identity "$archive_dir")" != "$current_id" ]]; then
      rm -f -- "$checksum" "$checksum_partial" "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-drifted" >&2
      return 1
    fi
    printf '%s\n' "$current_id" > "$mount_id_partial"
    if ! mv -- "$mount_id_partial" "$mount_id" || [[ "$(cat -- "$mount_id" 2>/dev/null)" != "$current_id" ]]; then
      rm -f -- "$mount_id" "$mount_id_partial"
      echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-sidecar-failed" >&2
      return 1
    fi
  fi
  # Sidecar checksum from the digest computed during the single verification
  # read; the sidecar itself is tiny and compared by value, not re-hashed.
  if ! printf '%s  %s\n' "$archive_digest" "$(basename "$archive")" > "$checksum_partial"; then
    rm -f -- "$checksum_partial"
    echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-sidecar-write-failed" >&2
    return 1
  fi
  if ! mv -- "$checksum_partial" "$checksum"; then
    rm -f -- "$checksum"
    echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-sidecar-publish-failed" >&2
    return 1
  fi
  if [[ "$(cat -- "$checksum" 2>/dev/null)" != "$(printf '%s  %s\n' "$archive_digest" "$(basename "$archive")")" ]]; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-sidecar-inconsistent" >&2
    return 1
  fi

  # Independent persistence is part of a successful archive operation for
  # both same-day publication and retention deletion.  The FUSE path was read
  # only to construct the expected digest/size; it is never accepted as the
  # independent readback.  Retry only the small remote verifier call so a
  # delayed provider object does not trigger repeated full archive reads.
  if [[ ! -s "$mount_id" ]] || [[ "$(capture_dir_identity "$archive_dir" 2>/dev/null)" != "$(cat -- "$mount_id" 2>/dev/null)" ]]; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-mismatch-before-remote-readback" >&2
    return 1
  fi
  if ! remote_size="$(stat -c %s -- "$archive")"; then
    echo "[cloud_db_backup] keep local backup=$source_dir reason=offsite-size-unavailable" >&2
    return 1
  fi
  rel="$archive_day/$base.tar"
  if verify_independent_remote_with_retry "$rel" "$archive_digest" "$remote_size" post-publish; then
    :
  else
    remote_status=$?
    echo "[cloud_db_backup] keep local backup=$source_dir reason=independent-remote-unconfirmed terminal_status=$remote_status" >&2
    return "$remote_status"
  fi

  if [[ "$remove_after" == "1" ]]; then
    # Local deletion is permitted only when every gate passes.  The first
    # independent readback above cannot authorize deletion across the slow
    # local full-content revalidation below: perform a second remote readback
    # after that I/O, then re-bind the mount immediately before removal.
    if ! validate_local_backup "$source_dir" ||
       ! current_manifest_digest="$(sha256sum -- "$source_dir/SHA256SUMS.txt" | awk '{print $1}')" ||
       [[ "$current_manifest_digest" != "$local_manifest_digest" ]]; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=local-source-changed-before-delete" >&2
      return 1
    fi
    if [[ ! -s "$mount_id" ]] || [[ "$(capture_dir_identity "$archive_dir" 2>/dev/null)" != "$(cat -- "$mount_id" 2>/dev/null)" ]]; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-mismatch-before-final-remote-readback" >&2
      return 1
    fi
    if verify_independent_remote_with_retry "$rel" "$archive_digest" "$remote_size" pre-delete; then
      :
    else
      remote_status=$?
      echo "[cloud_db_backup] keep local backup=$source_dir reason=independent-remote-unconfirmed-before-delete terminal_status=$remote_status" >&2
      return "$remote_status"
    fi
    # This is intentionally lightweight so no new slow local read opens a
    # fresh remote-TOCTOU window after the final independent confirmation.
    # Remote stores without an atomic object lease still have an unavoidable
    # sub-operation race after confirmation; every observable drift here fails
    # closed rather than deleting through a changed FUSE mount.
    if [[ ! -s "$mount_id" ]] || [[ "$(capture_dir_identity "$archive_dir" 2>/dev/null)" != "$(cat -- "$mount_id" 2>/dev/null)" ]]; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=cos-identity-mismatch-at-final-delete-gate" >&2
      return 1
    fi
    # The source path itself must still be the exact direct child of the
    # retention root that was first verified: same canonical path, same
    # parent, not a symlink, and the same directory-entry identity.  Any
    # observable drift keeps the (possibly swapped) directory and fails
    # closed instead of deleting through a replaced path.
    if ! final_source_real="$(realpath -e -- "$source_dir" 2>/dev/null)"; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=source-path-unresolvable-at-final-delete-gate" >&2
      return 1
    fi
    if [[ "$final_source_real" != "$source_real" ]] ||
       [[ "$(dirname "$final_source_real")" != "$root_real" ]] ||
       [[ -L "$source_dir" ]] ||
       [[ "$(basename "$source_dir")" != "$base" ]] ||
       [[ "$(stat -c '%d:%i' -- "$source_dir" 2>/dev/null)" != "$source_identity" ]]; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=source-identity-drifted-at-final-delete-gate" >&2
      return 1
    fi
    # The retention root must be root-owned and not writable by group or
    # other.  A group/other-writable parent would let an attacker rename the
    # quarantine away or re-swap the source path after it has been renamed,
    # so the local-deletion gate fails closed when the parent is not secure.
    # The test-only bypass is inert outside SHEIN_BI_BACKUP_TEST_MODE=1.
    if ! verify_delete_parent_secure "$root_real"; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=delete-parent-not-secure local-preserved=1" >&2
      return 1
    fi
    # Test-only path-swap hook (after-final-identity-before-quarantine): in
    # test mode it simulates an attacker swap landing exactly between the
    # final identity check and the quarantine rename.  The quarantine
    # re-verification below must then detect the inode drift, keep the
    # quarantine and never delete either directory.  Always a no-op outside
    # test mode.
    after_final_identity_before_quarantine "$source_dir" || return $?
    # Atomic move of the verified directory to a UNIQUE hidden quarantine in
    # the same controlled parent directory.  After the rename the name
    # "$source_dir" no longer exists, so a later swap cannot redirect the
    # delete anywhere else.
    quarantine="$root_real/.quarantine-$base-$STAMP-$$"
    if ! mv -T -- "$source_dir" "$quarantine"; then
      echo "[cloud_db_backup] keep local backup=$source_dir reason=quarantine-rename-failed local-preserved=1" >&2
      return 1
    fi
    # Re-verify the LOCKED identity at its new quarantine location: the
    # quarantined directory must still be the exact inode verified above and
    # its checksum manifest must still match.  Any inconsistency keeps the
    # quarantine and never deletes it; only a re-verified same-identity
    # directory may be removed.  The quarantine name is unique (hidden,
    # stamped, PID-scoped) and the parent is not group/other-writable, so
    # nothing can be renamed over it between this check and the removal.
    if ! quarantine_identity="$(stat -c '%d:%i' -- "$quarantine" 2>/dev/null)" ||
       [[ "$quarantine_identity" != "$source_identity" ]] ||
       ! quarantined_manifest_digest="$(sha256sum -- "$quarantine/SHA256SUMS.txt" | awk '{print $1}')" ||
       [[ "$quarantined_manifest_digest" != "$local_manifest_digest" ]]; then
      echo "[cloud_db_backup] keep quarantined backup=$quarantine reason=quarantine-identity-drift source=$source_dir local-preserved=1" >&2
      return 1
    fi
    if ! rm -rf -- "$quarantine" || [[ -e "$quarantine" ]]; then
      echo "[cloud_db_backup] verified archive=$archive but local removal failed=$quarantine" >&2
      return 1
    fi
    echo "[cloud_db_backup] archived=$archive removed=$source_dir"
  else
    echo "[cloud_db_backup] offsite-verified=$archive local-preserved=$source_dir"
  fi
}

prune_expired() {
  local expired=() failed=0 status=0 terminal=0
  # Hidden directories (.pending-* staging and other housekeeping) are never
  # retention candidates, so a crashed staging dir cannot poison prune.
  mapfile -d '' expired < <(
    find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '.*' -prune \
      -o -type d -mtime +"$RETENTION_DAYS" -print0
  )
  if (( ${#expired[@]} == 0 )); then
    echo "[cloud_db_backup] retention no expired backups"
    return 0
  fi
  if ! cos_ready; then
    echo "[cloud_db_backup] retention skipped: COS unavailable; local backups preserved" >&2
    return 0
  fi
  for source_dir in "${expired[@]}"; do
    # Expired backups are deleted only after an independent remote
    # confirmation; without a configured verifier archive_verified fails
    # closed and every local copy is preserved, which is the safe outcome.
    # Progression note: `if ! func; then status=$?` would read 0 (the negated
    # condition), so the else-of-if form is used to keep the true status.
    if archive_verified "$source_dir" 1; then
      :
    else
      status=$?
      failed=1
      if (( status == REMOTE_VERIFY_CONFIG_STATUS )); then
        # Verifier configuration error: terminal, never collapsed to 74.
        if (( terminal != REMOTE_VERIFY_CONFIG_STATUS )); then
          terminal="$REMOTE_VERIFY_CONFIG_STATUS"
        fi
      elif (( status == REMOTE_VERIFY_EXHAUSTED_STATUS )); then
        # I/O retry exhaustion is the documented 74 terminal.
        if (( terminal != REMOTE_VERIFY_CONFIG_STATUS )); then
          terminal="$REMOTE_VERIFY_EXHAUSTED_STATUS"
        fi
      fi
    fi
  done
  if (( terminal != 0 )); then
    echo "[cloud_db_backup] retention terminal=remote-verify status=$terminal local-preserved=1" >&2
    return "$terminal"
  fi
  return "$failed"
}

test_staging_cleanup() {
  local fresh stale stale_epoch
  mkdir -p "$BACKUP_ROOT"
  fresh="$BACKUP_ROOT/.pending-fresh-$$"
  stale="$BACKUP_ROOT/.pending-stale-$$"
  mkdir -p "$fresh" "$stale"
  stale_epoch=$(( $(date +%s) - 60 * 60 * 12 ))
  touch -d "@$stale_epoch" "$stale"
  cleanup_stale_staging >/dev/null
  if [[ -d "$stale" ]]; then
    echo "[cloud_db_backup] stale staging was not cleaned" >&2
    return 1
  fi
  if [[ ! -d "$fresh" ]]; then
    echo "[cloud_db_backup] fresh staging was wrongly cleaned" >&2
    return 1
  fi
  # The fresh fixture is left in place so the contract test can assert it
  echo "[cloud_db_backup] staging-cleanup-ok"
}

# Restricted test-mode dispatch (guarded by SHEIN_BI_BACKUP_TEST_MODE=1).
if [[ -n "$TEST_ARCHIVE_SOURCE" ]]; then
  mkdir -p "$BACKUP_ROOT" "$COS_ARCHIVE_ROOT"
  archive_verified "$TEST_ARCHIVE_SOURCE" "$TEST_ARCHIVE_REMOVE_AFTER"
  exit $?
fi
if [[ -n "$TEST_RECEIPT_FILE" ]]; then
  verify_browser_state_receipt "$TEST_RECEIPT_FILE"
  exit $?
fi
if [[ "$TEST_STAGING_CLEANUP" == "1" ]]; then
  test_staging_cleanup
  exit $?
fi
if [[ "$TEST_STAGING_TRAP" == "1" ]]; then
  mkdir -p "$BACKUP_ROOT"
  if [[ -e "$OUT_STAGING" ]]; then
    echo "[cloud_db_backup] test staging collision" >&2
    exit 73
  fi
  mkdir -p "$OUT_STAGING"
  echo "[cloud_db_backup] test staging trap engaged"
  exit 7
fi

mkdir -p "$BACKUP_ROOT"
cleanup_stale_staging
if (( PRUNE_ONLY == 0 )); then
  if [[ -e "$OUT_STAGING" ]]; then
    echo "[cloud_db_backup] staging collision: $OUT_STAGING" >&2
    exit 73
  fi
  if [[ -e "$OUT_DIR" ]]; then
    echo "[cloud_db_backup] final backup collision: $OUT_DIR" >&2
    exit 73
  fi
  mkdir -p "$OUT_STAGING"
  echo "[cloud_db_backup] start out=$OUT_DIR staging=$OUT_STAGING"

  docker exec shein-warehouse-db pg_dump -U shein -d shein_bi -Fc > "$OUT_STAGING/shein_bi.dump"
  if docker ps --format '{{.Names}}' | grep -qx 'shein-metabase-db'; then
    docker exec shein-metabase-db pg_dump -U metabase -d metabase -Fc > "$OUT_STAGING/metabase.dump"
  else
    echo "[cloud_db_backup] skip metabase.dump: shein-metabase-db is not running (Metabase is archived/manual)"
  fi
  if [[ -s "$MANUAL_LIMITED_DISCOUNT_REGISTRY" ]]; then
    cp -- "$MANUAL_LIMITED_DISCOUNT_REGISTRY" "$OUT_STAGING/marketing_manual_limited_discount_overrides.json"
  else
    echo "[cloud_db_backup] WARN manual limited-discount registry missing: $MANUAL_LIMITED_DISCOUNT_REGISTRY" >&2
  fi

  if [[ "$BROWSER_STATE_BACKUP_ENABLED" == "1" ]]; then
    # Both roots are mandatory.  A missing profile or session root aborts
    # with a non-zero exit before any success marker, verification, offsite
    # mirror or deletion chain can run.
    [[ -d "$BROWSER_PROFILE_ROOT" ]] || {
      echo "[cloud_db_backup] browser profile root missing: $BROWSER_PROFILE_ROOT" >&2
      exit 66
    }
    [[ -d "$BROWSER_SESSION_ROOT" ]] || {
      echo "[cloud_db_backup] browser session root missing: $BROWSER_SESSION_ROOT" >&2
      exit 66
    }
    [[ -f "$BROWSER_STATE_BACKUP_KEY_FILE" ]] || {
      echo "[cloud_db_backup] browser-state backup key missing: $BROWSER_STATE_BACKUP_KEY_FILE" >&2
      exit 66
    }
    node "$MANAGE_BROWSER_STATE" create \
      --key-file "$BROWSER_STATE_BACKUP_KEY_FILE" \
      --output "$OUT_STAGING/browser-state.sheinenc" \
      --limit-total-bytes "$BROWSER_STATE_LIMIT_TOTAL_BYTES" \
      --source "profiles=$BROWSER_PROFILE_ROOT" \
      --source "state/shein_webapi_sessions=$BROWSER_SESSION_ROOT" \
      > "$OUT_STAGING/browser-state.create.json"
    verify_browser_state_receipt "$OUT_STAGING/browser-state.create.json"
    node "$MANAGE_BROWSER_STATE" verify \
      --key-file "$BROWSER_STATE_BACKUP_KEY_FILE" \
      --archive "$OUT_STAGING/browser-state.sheinenc" \
      --limit-total-bytes "$BROWSER_STATE_LIMIT_TOTAL_BYTES" \
      > "$OUT_STAGING/browser-state.verify.json"
    echo "[cloud_db_backup] encrypted browser/session state captured and verified"
  elif [[ "$BROWSER_STATE_BACKUP_ENABLED" != "0" ]]; then
    echo "[cloud_db_backup] invalid SHEIN_BI_BROWSER_STATE_BACKUP_ENABLED=$BROWSER_STATE_BACKUP_ENABLED" >&2
    exit 64
  else
    echo "[cloud_db_backup] WARN encrypted browser/session state backup explicitly disabled" >&2
  fi

  (
    cd "$OUT_STAGING"
    find . -mindepth 1 -maxdepth 1 -type f ! -name 'SHA256SUMS.txt' -printf '%P\0' |
      LC_ALL=C sort -z |
      xargs -0 -r sha256sum -- > SHA256SUMS.txt
    validate_local_backup "$OUT_STAGING"
  )
  du -sh "$OUT_STAGING"
  # Atomic publication: the final OUT_DIR appears only after every stage
  # (dumps, browser state + receipt + verify, manifest + local validation)
  # succeeded.  A failure before this point leaves only the TEMPORARY staging
  # directory, which the EXIT trap removes, so no permanent partial final
  # backup directory is ever left behind.
  staging_identity="$(stat -c '%d:%i' -- "$OUT_STAGING")" || {
    echo "[cloud_db_backup] local staging identity unavailable" >&2
    exit 73
  }
  if ! mv -T -- "$OUT_STAGING" "$OUT_DIR"; then
    echo "[cloud_db_backup] local publish failed" >&2
    exit 73
  fi
  if [[ -e "$OUT_STAGING" ]] || [[ "$(stat -c '%d:%i' -- "$OUT_DIR" 2>/dev/null)" != "$staging_identity" ]]; then
    echo "[cloud_db_backup] local publish identity readback failed; final path preserved for inspection" >&2
    exit 73
  fi
  STAGING_PUBLISHED=1
  if wait_for_cos_ready_with_retry; then
    if archive_verified "$OUT_DIR" 0; then
      :
    else
      same_day_status=$?
      echo "[cloud_db_backup] same-day offsite terminal=failed status=$same_day_status local-preserved=$OUT_DIR" >&2
      exit "$same_day_status"
    fi
  else
    same_day_status=$?
    echo "[cloud_db_backup] same-day offsite terminal=exhausted status=$same_day_status reason=cos-unavailable local-preserved=$OUT_DIR" >&2
    exit "$same_day_status"
  fi
else
  echo "[cloud_db_backup] prune-only"
fi

prune_expired
echo "[cloud_db_backup] done out=${OUT_DIR:-none} retention_days=$RETENTION_DAYS prune_only=$PRUNE_ONLY"
