#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${SHEIN_BI_ROOT:-/opt/shein-bi/app}"
OUTPUT_DIR="${SHEIN_BI_OUTPUT_DIR:-$ROOT/outputs}"
PROFILES_DIR="${SHEIN_BI_PROFILES_DIR:-$ROOT/profiles}"
OFFSITE_ENABLED="${SHEIN_BI_BACKUP_OFFSITE_ENABLED:-1}"
COS_MOUNT="${SHEIN_BI_COS_MOUNT:-/lhcos-data}"
COS_ARCHIVE_ROOT="${SHEIN_BI_COS_ARCHIVE_ROOT:-$COS_MOUNT/shein-bi-archive}"
LOG_DIR="${SHEIN_BI_DISK_MAINTENANCE_LOG_DIR:-/srv/shein-bi/logs/disk-maintenance}"
LOCK_FILE="${SHEIN_BI_DISK_MAINTENANCE_LOCK_FILE:-$ROOT/state/locks/shein-bi-cloud-disk-maintenance.lock}"
OUTPUT_RETENTION_DAYS="${SHEIN_BI_OUTPUT_RETENTION_DAYS:-30}"
TMP_RETENTION_DAYS="${SHEIN_BI_TMP_RETENTION_DAYS:-7}"
CACHE_THRESHOLD_PERCENT="${SHEIN_BI_PROFILE_CACHE_THRESHOLD_PERCENT:-80}"
TZ_NAME="${SHEIN_BI_TZ:-Asia/Shanghai}"

DRY_RUN=0
FORCE_CACHE=0
FORCE_ARCHIVE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force-cache) FORCE_CACHE=1 ;;
    --force-archive) FORCE_ARCHIVE=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 64 ;;
  esac
done

case "$OFFSITE_ENABLED" in
  0|1) ;;
  *)
    echo "[cloud_disk_maintenance] invalid SHEIN_BI_BACKUP_OFFSITE_ENABLED=$OFFSITE_ENABLED; expected 0 or 1" >&2
    exit 64
    ;;
esac

if [[ ! -d "$ROOT" || ! -d "$OUTPUT_DIR" || ! -d "$PROFILES_DIR" ]]; then
  echo "Required runtime directory is missing under $ROOT" >&2
  exit 66
fi
if [[ ! "$OUTPUT_DIR" == "$ROOT"/* || ! "$PROFILES_DIR" == "$ROOT"/* ]]; then
  echo "Refusing paths outside SHEIN_BI_ROOT" >&2
  exit 73
fi

# shellcheck source=scripts/lib/shared_lock.sh
source "$ROOT/scripts/lib/shared_lock.sh"
prepare_shared_lock_file "$LOCK_FILE"
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[cloud_disk_maintenance] another run owns $LOCK_FILE; skip"
  exit 0
fi

mkdir -p "$LOG_DIR"
STAMP="$(TZ="$TZ_NAME" date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/disk-maintenance-$STAMP.log"
exec > >(tee -a "$LOG_FILE") 2>&1

disk_percent() {
  df -P "$ROOT" | awk 'NR==2 {gsub(/%/, "", $5); print $5}'
}

cos_ready() {
  local probe
  mountpoint -q "$COS_MOUNT" || return 1
  [[ -d "$COS_MOUNT" && -w "$COS_MOUNT" ]] || return 1
  probe="$COS_MOUNT/.shein-bi-maintenance-probe-$STAMP-$$"
  printf 'probe %s\n' "$STAMP" > "$probe" || return 1
  [[ -s "$probe" ]] || return 1
  rm -f -- "$probe"
}

active_browser_leases() {
  (
    cd "$ROOT"
    node --input-type=module -e \
      "import {readBrowserLeases} from './lib/browser_task_lease.mjs'; process.stdout.write(String(readBrowserLeases({root:process.cwd()}).filter(x=>x.valid).length));"
  )
}

cleanup_profile_caches() {
  local use_percent lease_count
  use_percent="$(disk_percent)"
  if (( ! FORCE_CACHE && use_percent < CACHE_THRESHOLD_PERCENT )); then
    echo "[profile-cache] skip disk=${use_percent}% threshold=${CACHE_THRESHOLD_PERCENT}%"
    return 0
  fi
  lease_count="$(active_browser_leases)"
  if [[ "$lease_count" != "0" ]]; then
    echo "[profile-cache] skip active_browser_leases=$lease_count"
    return 0
  fi
  if pgrep -f 'chrome|chromium|playwright' >/dev/null 2>&1; then
    echo "[profile-cache] skip live browser process detected"
    return 0
  fi

  PROFILES_DIR="$PROFILES_DIR" DRY_RUN="$DRY_RUN" python3 - <<'PY'
from pathlib import Path
import json, os, shutil

root = Path(os.environ['PROFILES_DIR']).resolve()
dry_run = os.environ.get('DRY_RUN') == '1'
cache_names = {
    'Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache',
    'GraphiteDawnCache', 'DawnCache', 'CacheStorage', 'ScriptCache',
    'component_crx_cache', 'Crashpad', 'OptGuideOnDeviceModel',
}

def size_bytes(path):
    total = 0
    for base, _, files in os.walk(path):
        for name in files:
            try:
                total += (Path(base) / name).stat().st_size
            except OSError:
                pass
    return total

raw = []
for candidate in root.rglob('*'):
    try:
        if candidate.is_dir() and not candidate.is_symlink() and candidate.name in cache_names:
            candidate.resolve().relative_to(root)
            raw.append(candidate)
    except (OSError, ValueError):
        pass
raw.sort(key=lambda item: len(item.parts))
selected = []
for candidate in raw:
    if any(parent in selected for parent in candidate.parents):
        continue
    selected.append(candidate)

removed = []
for candidate in selected:
    before = size_bytes(candidate)
    if not dry_run:
        shutil.rmtree(candidate)
    removed.append({'path': str(candidate.relative_to(root)), 'bytes': before})
print(json.dumps({
    'dryRun': dry_run,
    'candidateCount': len(removed),
    'reclaimableBytes': sum(item['bytes'] for item in removed),
}, ensure_ascii=False))
PY
}

archive_old_outputs() {
  local archive_day archive_dir list_file manifest_file archive partial_archive delete_report
  local selected_count archive_sha output_relative first_old skipped_count
  if [[ "$OFFSITE_ENABLED" == "0" ]]; then
    echo "[outputs] skip COS archive in local-only mode; old outputs retained"
    return 0
  fi
  first_old="$(find "$OUTPUT_DIR" -xdev -type f -mtime +"$OUTPUT_RETENTION_DAYS" -print -quit)"
  if (( ! FORCE_ARCHIVE )) && [[ -z "$first_old" ]]; then
    echo "[outputs] skip no files older than ${OUTPUT_RETENTION_DAYS} days"
    return 0
  fi
  if ! cos_ready; then
    echo "[outputs] skip COS is not mounted and writable; local files retained"
    return 0
  fi

  archive_day="$(TZ="$TZ_NAME" date +%F)"
  archive_dir="$COS_ARCHIVE_ROOT/$archive_day"
  mkdir -p "$archive_dir"
  list_file="$LOG_DIR/outputs-$STAMP.files0"
  manifest_file="$LOG_DIR/outputs-$STAMP.manifest.json"
  delete_report="$LOG_DIR/outputs-$STAMP.delete.json"
  archive="$archive_dir/outputs-older-than-${OUTPUT_RETENTION_DAYS}d-$STAMP.tar.gz"
  partial_archive="$archive.partial"
  [[ ! -e "$archive" && ! -e "$partial_archive" ]] || {
    echo "[outputs] archive target already exists: $archive" >&2
    return 74
  }

  output_relative="${OUTPUT_DIR#"$ROOT"/}"
  (
    cd "$ROOT"
    find "$output_relative" -xdev -type f -mtime +"$OUTPUT_RETENTION_DAYS" -print0 > "$list_file"
  )
  ROOT="$ROOT" OUTPUT_DIR="$OUTPUT_DIR" LIST_FILE="$list_file" MANIFEST_FILE="$manifest_file" python3 - <<'PY'
from pathlib import Path
import json, os, time

root = Path(os.environ['ROOT']).resolve()
outputs = Path(os.environ['OUTPUT_DIR']).resolve()
paths = [os.fsdecode(item) for item in Path(os.environ['LIST_FILE']).read_bytes().split(b'\0') if item]
records = []
for relative in paths:
    target = (root / relative).resolve()
    target.relative_to(outputs)
    stat = target.stat()
    records.append({'path': relative, 'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns})
document = {
    'createdAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'count': len(records),
    'bytes': sum(item['size'] for item in records),
    'files': records,
}
Path(os.environ['MANIFEST_FILE']).write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({key: document[key] for key in ('createdAt', 'count', 'bytes')}, ensure_ascii=False))
PY
  selected_count="$(python3 -c "import json; print(json.load(open('$manifest_file', encoding='utf-8'))['count'])")"
  if [[ "$selected_count" == "0" ]]; then
    rm -f -- "$list_file" "$manifest_file"
    echo "[outputs] skip no files older than ${OUTPUT_RETENTION_DAYS} days"
    return 0
  fi
  if (( DRY_RUN )); then
    echo "[outputs] dry-run selected_count=$selected_count; local files retained"
    rm -f -- "$list_file" "$manifest_file"
    return 0
  fi

  (
    cd "$ROOT"
    tar --no-recursion --null --files-from="$list_file" -cf - | gzip -1 > "$partial_archive"
  )
  gzip -t "$partial_archive"
  ARCHIVE="$partial_archive" MANIFEST_FILE="$manifest_file" python3 - <<'PY'
import json, os, tarfile

expected = [item['path'] for item in json.load(open(os.environ['MANIFEST_FILE'], encoding='utf-8'))['files']]
with tarfile.open(os.environ['ARCHIVE'], 'r:gz') as handle:
    actual = [member.name for member in handle]
if actual != expected:
    raise SystemExit(f'archive member mismatch expected={len(expected)} actual={len(actual)}')
print(f'[outputs] verified archive members={len(actual)}')
PY
  archive_sha="$(sha256sum "$partial_archive" | awk '{print $1}')"
  mv -- "$partial_archive" "$archive"
  cp -- "$manifest_file" "$archive_dir/"
  printf '%s  %s\n' "$archive_sha" "$(basename "$archive")" > "$archive.sha256"

  ROOT="$ROOT" OUTPUT_DIR="$OUTPUT_DIR" MANIFEST_FILE="$manifest_file" DELETE_REPORT="$delete_report" python3 - <<'PY'
from pathlib import Path
import json, os, time

root = Path(os.environ['ROOT']).resolve()
outputs = Path(os.environ['OUTPUT_DIR']).resolve()
document = json.loads(Path(os.environ['MANIFEST_FILE']).read_text(encoding='utf-8'))
removed = []
skipped = []
for record in document['files']:
    target = (root / record['path']).resolve()
    try:
        target.relative_to(outputs)
    except ValueError:
        skipped.append({'path': record['path'], 'reason': 'outside_outputs'})
        continue
    try:
        stat = target.stat()
    except FileNotFoundError:
        skipped.append({'path': record['path'], 'reason': 'already_missing'})
        continue
    if stat.st_size != record['size'] or stat.st_mtime_ns != record['mtime_ns']:
        skipped.append({'path': record['path'], 'reason': 'changed_since_archive'})
        continue
    target.unlink()
    removed.append(record)
report = {
    'completedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'removedCount': len(removed),
    'removedBytes': sum(item['size'] for item in removed),
    'skippedCount': len(skipped),
    'skipped': skipped,
}
Path(os.environ['DELETE_REPORT']).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
PY
  cp -- "$delete_report" "$archive_dir/"
  find "$OUTPUT_DIR" -xdev -mindepth 1 -depth -type d -empty -delete
  rm -f -- "$list_file"
  echo "[outputs] archived=$archive sha256=$archive_sha"
  skipped_count="$(python3 -c "import json; print(json.load(open('$delete_report', encoding='utf-8'))['skippedCount'])")"
  if [[ "$skipped_count" != "0" ]]; then
    echo "[outputs] archived safely but $skipped_count changed files were retained" >&2
    return 75
  fi
}

cleanup_stale_tmp() {
  local tmp_dir="$ROOT/tmp" count bytes
  [[ -d "$tmp_dir" ]] || return 0
  if command -v lsof >/dev/null 2>&1 && lsof +D "$tmp_dir" 2>/dev/null | tail -n +2 | grep -q .; then
    echo "[tmp] skip open files detected"
    return 0
  fi
  count="$(find "$tmp_dir" -xdev -type f -mtime +"$TMP_RETENTION_DAYS" | wc -l)"
  bytes="$(find "$tmp_dir" -xdev -type f -mtime +"$TMP_RETENTION_DAYS" -printf '%s\n' | awk '{total+=$1} END {printf "%.0f", total+0}')"
  echo "[tmp] selected_count=$count selected_bytes=$bytes dry_run=$DRY_RUN"
  if (( ! DRY_RUN )); then
    find "$tmp_dir" -xdev -type f -mtime +"$TMP_RETENTION_DAYS" -delete
    find "$tmp_dir" -xdev -mindepth 1 -depth -type d -empty -delete
  fi
}

echo "[cloud_disk_maintenance] start stamp=$STAMP disk=$(disk_percent)% dry_run=$DRY_RUN offsite_enabled=$OFFSITE_ENABLED"
cleanup_profile_caches
archive_old_outputs
cleanup_stale_tmp
echo "[cloud_disk_maintenance] done disk=$(disk_percent)% log=$LOG_FILE"
