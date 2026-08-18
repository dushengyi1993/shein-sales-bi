#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# This script runs as root in production, but every Git operation is read-only.
# Disable optional index refresh locks so `git status` cannot rewrite .git/index
# with root ownership and lock the deployment user out of the repository.
export GIT_OPTIONAL_LOCKS=0

readonly CONFIRMATION='MIGRATE_CLOUD_RUNTIME_LAYOUT_V2'
readonly STANDARD_ROOT='/opt/shein-bi/app'
readonly STANDARD_DATA_ROOT='/data/shein-bi'
readonly STANDARD_FSTAB='/etc/fstab'
readonly STANDARD_SYSTEMD_DIR='/etc/systemd/system'
readonly STANDARD_MAINTENANCE_MARKER='/var/lib/shein-bi-control/cloud-maintenance.json'
readonly STANDARD_BACKUP_ROOT='/var/lib/shein-bi-layout-migration-backups'
readonly KNOWN_PHASES='init|fstab-backed-up|state-data-created|outputs-underlay-prepared|outputs-underlay-moved|state-underlay-moved|readonly-mounts-done|fstab-publish-prepared|fstab-published|verified|rolled-back'

ROOT="$STANDARD_ROOT"
DATA_ROOT="$STANDARD_DATA_ROOT"
FSTAB="$STANDARD_FSTAB"
SYSTEMD_DIR="$STANDARD_SYSTEMD_DIR"
MAINTENANCE_MARKER="$STANDARD_MAINTENANCE_MARKER"
BACKUP_ROOT="$STANDARD_BACKUP_ROOT"
SYSTEMCTL_BIN="${SHEIN_BI_SYSTEMCTL_BIN:-systemctl}"
FINDMNT_BIN="${SHEIN_BI_FINDMNT_BIN:-findmnt}"
MOUNTPOINT_BIN="${SHEIN_BI_MOUNTPOINT_BIN:-mountpoint}"
MOUNT_BIN="${SHEIN_BI_MOUNT_BIN:-mount}"
UMOUNT_BIN="${SHEIN_BI_UMOUNT_BIN:-umount}"
PGREP_BIN="${SHEIN_BI_PGREP_BIN:-pgrep}"
RSYNC_BIN="${SHEIN_BI_RSYNC_BIN:-rsync}"
GIT_BIN="${SHEIN_BI_GIT_BIN:-git}"
SYSTEMD_ESCAPE_BIN="${SHEIN_BI_SYSTEMD_ESCAPE_BIN:-systemd-escape}"
TAR_BIN="${SHEIN_BI_TAR_BIN:-tar}"
APPLY=0
ROLLBACK_FLAG=0
FIXTURE=0
CONFIRM=''
COMPLETED=0
RESOLVED_ACTION='fresh'
ACTION_LABEL='fresh'
BACKUP_RUN_DIR=''
STAMP=''
PHASE=''
FSTAB_SOURCE_HASH=''
FSTAB_BACKUP_HASH=''
STATE_SOURCE_FP=''
OUTPUTS_SOURCE_FP=''
FINGERPRINT_READY=0
FINGERPRINT_TAR_VERSION=''
EXPECTED_FSTAB_V2_HASH=''
FSTAB_STAGE_PATH=''
ROLLBACK_RUNNING=0
ROLLBACK_MUTATION_STARTED=0
ROLLBACK_RESUMING=0
ROLLBACK_PHASE=''
ROLLBACK_FSTAB_CURRENT_HASH=''
ROLLBACK_FSTAB_BACKUP_HASH=''
STAGE_COUNT=0

usage() {
  printf '%s\n' "Usage: $0 [--fixture] [--root <absolute-app-root>] [--data-root <absolute-data-root>] [--fstab <absolute-file>] [--systemd-dir <absolute-directory>] [--maintenance-marker <absolute-file>] [--backup-root <absolute-directory>] [--apply|--rollback --confirm $CONFIRMATION]" >&2
}

usage_error() {
  printf 'configuration_error=%s\n' "$1" >&2
  usage
  exit 64
}

fail() {
  printf 'runtime_layout_migration_error=%s\n' "$1" >&2
  exit 1
}

declare -A seen=()
while (($#)); do
  case "$1" in
    --fixture)
      [[ -z "${seen[fixture]+x}" ]] || usage_error 'duplicate --fixture'
      seen[fixture]=1
      FIXTURE=1
      shift
      ;;
    --root|--data-root|--fstab|--systemd-dir|--maintenance-marker|--backup-root|--confirm)
      key="${1#--}"
      [[ -z "${seen[$key]+x}" ]] || usage_error "duplicate $1"
      (($# >= 2)) || usage_error "missing value for $1"
      seen[$key]=1
      case "$1" in
        --root) ROOT="$2" ;;
        --data-root) DATA_ROOT="$2" ;;
        --fstab) FSTAB="$2" ;;
        --systemd-dir) SYSTEMD_DIR="$2" ;;
        --maintenance-marker) MAINTENANCE_MARKER="$2" ;;
        --backup-root) BACKUP_ROOT="$2" ;;
        --confirm) CONFIRM="$2" ;;
      esac
      shift 2
      ;;
    --apply)
      [[ -z "${seen[apply]+x}" ]] || usage_error 'duplicate --apply'
      seen[apply]=1
      APPLY=1
      shift
      ;;
    --rollback)
      [[ -z "${seen[rollback]+x}" ]] || usage_error 'duplicate --rollback'
      seen[rollback]=1
      ROLLBACK_FLAG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

for value in "$ROOT" "$DATA_ROOT" "$FSTAB" "$SYSTEMD_DIR" "$MAINTENANCE_MARKER" "$BACKUP_ROOT"; do
  [[ "$value" == /* ]] || usage_error 'all configured paths must be absolute'
done
ROOT="${ROOT%/}"
DATA_ROOT="${DATA_ROOT%/}"
SYSTEMD_DIR="${SYSTEMD_DIR%/}"
BACKUP_ROOT="${BACKUP_ROOT%/}"
[[ -n "$ROOT" && "$ROOT" != '/' ]] || usage_error 'unsafe --root'
[[ -n "$DATA_ROOT" && "$DATA_ROOT" != '/' ]] || usage_error 'unsafe --data-root'
[[ -n "$SYSTEMD_DIR" && "$SYSTEMD_DIR" != '/' ]] || usage_error 'unsafe --systemd-dir'
[[ -n "$BACKUP_ROOT" && "$BACKUP_ROOT" != '/' ]] || usage_error 'unsafe --backup-root'
[[ "$APPLY" == 1 && "$ROLLBACK_FLAG" == 1 ]] && usage_error '--apply and --rollback are mutually exclusive'
if ((APPLY || ROLLBACK_FLAG)); then
  [[ "$CONFIRM" == "$CONFIRMATION" ]] || usage_error "--apply/--rollback requires exact --confirm $CONFIRMATION"
elif [[ -n "${seen[confirm]+x}" ]]; then
  usage_error '--confirm is valid only with --apply or --rollback'
fi

if ((!FIXTURE)); then
  [[ "$ROOT" == "$STANDARD_ROOT" ]] || usage_error 'real mode requires --root /opt/shein-bi/app'
  [[ "$DATA_ROOT" == "$STANDARD_DATA_ROOT" ]] || usage_error 'real mode requires --data-root /data/shein-bi'
  [[ "$FSTAB" == "$STANDARD_FSTAB" ]] || usage_error 'real mode requires --fstab /etc/fstab'
  [[ "$SYSTEMD_DIR" == "$STANDARD_SYSTEMD_DIR" ]] || usage_error 'real mode requires --systemd-dir /etc/systemd/system'
  [[ "$MAINTENANCE_MARKER" == "$STANDARD_MAINTENANCE_MARKER" ]] \
    || usage_error 'real mode requires the canonical maintenance marker'
  [[ "$BACKUP_ROOT" == "$STANDARD_BACKUP_ROOT" ]] \
    || usage_error 'real mode requires --backup-root /var/lib/shein-bi-layout-migration-backups'
  if ((APPLY || ROLLBACK_FLAG)) && ((EUID != 0)); then fail 'real apply/rollback requires root'; fi
  [[ -z "${SHEIN_BI_MIGRATION_STAGE_LIMIT:-}" && -z "${SHEIN_BI_MIGRATION_FAILPOINT:-}" ]] \
    || usage_error 'migration failpoints are fixture-only'
else
  [[ -n "${seen[root]+x}" && -n "${seen[data-root]+x}" && -n "${seen[fstab]+x}" \
    && -n "${seen[systemd-dir]+x}" && -n "${seen[maintenance-marker]+x}" \
    && -n "${seen[backup-root]+x}" ]] \
    || usage_error '--fixture requires explicit root, data-root, fstab, systemd-dir, maintenance-marker, and backup-root'
fi

APP_PROFILES="$ROOT/profiles"
APP_STATE="$ROOT/state"
APP_OUTPUTS="$ROOT/outputs"
DATA_PROFILES="$DATA_ROOT/profiles"
DATA_STATE="$DATA_ROOT/state"
DATA_OUTPUTS="$DATA_ROOT/outputs"
NAMESPACE_INSTALLER="$ROOT/scripts/install_cloud_runtime_path_namespaces.sh"
MAINTENANCE_INSTALLER="$ROOT/scripts/install_cloud_maintenance_guards.sh"
ATOMIC_PUBLISH_MODULE="$ROOT/lib/atomic_file_publish.mjs"
RUNTIME_INVENTORY_MODULE="$ROOT/lib/cloud_runtime_inventory.mjs"
RUNTIME_PATH_POLICY_MODULE="$ROOT/lib/cloud_runtime_path_policy.mjs"
RUNTIME_SNAPSHOT_MODULE="$ROOT/lib/cloud_runtime_snapshot.mjs"
SYSTEMD_SNAPSHOT_MODULE="$ROOT/lib/systemd_unit_snapshot.mjs"

assert_real_directory() {
  local path="$1"
  local label="$2"
  [[ -d "$path" && ! -L "$path" ]] || fail "$label must be a real non-symlink directory: $path"
  [[ "$(realpath -e -- "$path")" == "$path" ]] || fail "$label path must be canonical: $path"
}

assert_regular_file() {
  local path="$1"
  local label="$2"
  [[ -f "$path" && ! -L "$path" ]] || fail "$label must be a regular non-symlink file: $path"
  [[ "$(realpath -e -- "$path")" == "$path" ]] || fail "$label path must be canonical: $path"
}

assert_optional_real_directory() {
  local path="$1"
  local label="$2"
  if [[ ! -e "$path" && ! -L "$path" ]]; then return 0; fi
  assert_real_directory "$path" "$label"
}

assert_backup_root_path() {
  local parent
  [[ "$BACKUP_ROOT" != "$ROOT" && "$BACKUP_ROOT" != "$ROOT/"* ]] \
    || fail "backup root must stay outside the application source tree: $BACKUP_ROOT"
  if [[ -e "$BACKUP_ROOT" || -L "$BACKUP_ROOT" ]]; then
    assert_real_directory "$BACKUP_ROOT" 'layout migration backup root'
    return
  fi
  parent="$(dirname -- "$BACKUP_ROOT")"
  assert_real_directory "$parent" 'layout migration backup parent'
  [[ "$(realpath -m -- "$BACKUP_ROOT")" == "$BACKUP_ROOT" ]] \
    || fail "backup root path must be canonical: $BACKUP_ROOT"
}

assert_backup_root_device_compatible() {
  local root_device backup_device_probe backup_root_device state_underlay_device
  root_device="$(stat -Lc '%d' -- "$ROOT")" || fail 'cannot read application root device'
  if [[ -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]]; then
    backup_device_probe="$BACKUP_ROOT"
  else
    backup_device_probe="$(dirname -- "$BACKUP_ROOT")"
  fi
  backup_root_device="$(stat -Lc '%d' -- "$backup_device_probe")" || fail 'cannot read backup root device'
  [[ "$root_device" == "$backup_root_device" ]] \
    || fail "backup root must share the application underlay device: root=$root_device backup=$backup_root_device"
  if [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] && ! is_mountpoint "$APP_STATE"; then
    state_underlay_device="$(stat -Lc '%d' -- "$APP_STATE")" || fail 'cannot read state underlay device'
    [[ "$state_underlay_device" == "$root_device" ]] \
      || fail "state underlay must share the application device before migration: root=$root_device state=$state_underlay_device"
  fi
}

command_available() {
  local command="$1"
  if [[ "$command" == */* ]]; then
    [[ -x "$command" && ! -d "$command" ]]
  else
    command -v "$command" >/dev/null 2>&1
  fi
}

is_mountpoint() {
  "$MOUNTPOINT_BIN" -q -- "$1"
}

sha256_file() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  sha256sum -- "$path" | awk '{print $1}'
}

file_owner_mode() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  stat -Lc '%u:%g:%a' -- "$path"
}

assert_same_file_owner_mode() {
  local source="$1"
  local candidate="$2"
  local label="$3"
  local source_meta candidate_meta
  source_meta="$(file_owner_mode "$source")" || fail "cannot read source ownership/mode for $label"
  candidate_meta="$(file_owner_mode "$candidate")" || fail "cannot read candidate ownership/mode for $label"
  [[ "$candidate_meta" == "$source_meta" ]] \
    || fail "$label ownership/mode drifted: expected=$source_meta actual=$candidate_meta"
}

# FINGERPRINT_ENGINE_BEGIN
#
# The migration evidence fingerprint is a deterministic GNU tar byte stream
# hashed with sha256 over tree content, entry paths, mode, numeric uid/gid,
# ACLs, extended attributes (including security.capability), and hard-link
# topology. The archive is reproducible across runs because member order is
# fixed with --sort=name and the non-deterministic atime/ctime pax fields are
# explicitly deleted before hashing; source mtime remains authenticated. Symlinks
# are stored as symlinks (no --dereference / --hard-dereference) and hard links
# are stored as link records, so link topology participates in the hash.
# Special files (fifo/device) are archived with their metadata on GNU/Linux;
# on platforms where tar cannot read extended attributes for them (warnings on
# stderr), the fingerprint fails closed instead of silently weakening coverage.
# The engine is self-contained apart from TAR_BIN and FINGERPRINT_READY so the
# rollback tests can extract and run exactly this block under any GNU bash.
fingerprint_capability() {
  local version='' line='' major='' minor='' probe_dir='' probe_file='' h1='' h2='' h3=''
  version="$({ "$TAR_BIN" --version 2>/dev/null || true; })"
  version="${version%%$'\n'*}"
  case "$version" in
    *'GNU tar'*) ;;
    *) printf 'fingerprint_capability_required=gnu_tar_unavailable version=%s\n' "$version" >&2; return 1 ;;
  esac
  line="${version##* }"
  case "$line" in
    [0-9]*.[0-9]*) ;;
    *) printf 'fingerprint_capability_required=unparseable_version version=%s\n' "$version" >&2; return 1 ;;
  esac
  major="${line%%.*}"
  minor="${line#*.}"
  minor="${minor%%[^0-9]*}"
  (( major > 1 || (major == 1 && minor >= 28) )) || {
    printf 'fingerprint_capability_required=gnu_tar_too_old version=%s required_minimum=1.28\n' "$version" >&2
    return 1
  }
  probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/shein-bi-fp-probe.XXXXXX")" \
    || { printf 'fingerprint_capability_required=mktemp_failed\n' >&2; return 1; }
  probe_file="$probe_dir/probe.file"
  printf 'probe\n' >"$probe_file"
  chmod 0600 -- "$probe_file"
  if ! h1="$(tree_fingerprint "$probe_dir")"; then
    printf 'fingerprint_capability_required=baseline_fingerprint_failed\n' >&2
    find "$probe_dir" -depth -delete 2>/dev/null || true
    return 1
  fi
  touch -a -d '2000-01-01 00:00:00 UTC' -- "$probe_file" 2>/dev/null || true
  if ! h2="$(tree_fingerprint "$probe_dir")"; then
    printf 'fingerprint_capability_required=atime_fingerprint_failed\n' >&2
    find "$probe_dir" -depth -delete 2>/dev/null || true
    return 1
  fi
  if [[ "$h1" != "$h2" ]]; then
    printf 'fingerprint_capability_required=atime_included\n' >&2
    find "$probe_dir" -depth -delete 2>/dev/null || true
    return 1
  fi
  chmod 0600 -- "$probe_file"
  if ! h3="$(tree_fingerprint "$probe_dir")"; then
    printf 'fingerprint_capability_required=ctime_fingerprint_failed\n' >&2
    find "$probe_dir" -depth -delete 2>/dev/null || true
    return 1
  fi
  if [[ "$h1" != "$h3" ]]; then
    printf 'fingerprint_capability_required=ctime_included\n' >&2
    find "$probe_dir" -depth -delete 2>/dev/null || true
    return 1
  fi
  find "$probe_dir" -depth -delete 2>/dev/null || true
  FINGERPRINT_TAR_VERSION="$version"
  return 0
}

tree_fingerprint() {
  local path="$1" archive_hash='' err_file='' rc=0 msg=''
  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$FINGERPRINT_READY" == 1 ]] || return 1
  err_file="$(mktemp "${TMPDIR:-/tmp}/shein-bi-runtime-fp-err.XXXXXX")" || return 1
  if ! archive_hash="$({ LC_ALL=C "$TAR_BIN" --create --file=- \
        --sort=name --format=posix --numeric-owner \
        --pax-option=delete=atime,delete=ctime \
        --acls --xattrs --xattrs-include='*' --one-file-system \
        --directory "$path" .; } 2>"$err_file" | sha256sum | awk '{print $1}')"; then
    rc=1
  fi
  if ((rc != 0)) || [[ -s "$err_file" ]]; then
    msg="$(<"$err_file")"
    msg="${msg//$'\n'/ }"
    printf 'tree_fingerprint_failed=%s\n' "$msg" >&2
    rm -f -- "$err_file"
    return 1
  fi
  rm -f -- "$err_file"
  printf '%s\n' "$archive_hash"
}
# FINGERPRINT_ENGINE_END

render_fstab() {
  local action="$1"
  local file="${2:-$FSTAB}"
  node --input-type=module - "$action" "$file" \
    "$DATA_PROFILES" "$APP_PROFILES" "$DATA_STATE" "$APP_STATE" "$DATA_OUTPUTS" "$APP_OUTPUTS" <<'NODE_FSTAB'
// FSTAB_TRANSFORM_BEGIN
import fs from 'node:fs';

const [action, file, dataProfiles, appProfiles, dataState, appState, dataOutputs, appOutputs] = process.argv.slice(2);
const original = fs.readFileSync(file, 'utf8');
const finalNewline = original.endsWith('\n');
const lines = original.split('\n');
if (finalNewline) lines.pop();
const systemdDataDependency = 'x-systemd.requires=/data';
const legacyProfileOptions = new Set([
  'bind',
  'bind,rw',
  `bind,${systemdDataDependency}`,
  `bind,rw,${systemdDataDependency}`,
]);
const desiredProfileOptions = new Set([
  'bind,ro',
  `bind,ro,${systemdDataDependency}`,
]);
const desiredOptions = record => `bind,ro${record.options.includes(systemdDataDependency) ? `,${systemdDataDependency}` : ''}`;
const relevantPaths = new Set([dataProfiles, appProfiles, dataState, appState, dataOutputs, appOutputs]);
const records = {profiles: [], state: [], outputs: []};

for (let index = 0; index < lines.length; index += 1) {
  const raw = lines[index];
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const fields = trimmed.split(/\s+/u);
  const mentionsRelevant = fields.some(field => relevantPaths.has(field));
  if (!mentionsRelevant) continue;
  if (fields.length !== 6) throw new Error(`ambiguous runtime fstab line ${index + 1}: ${raw}`);
  const [source, target, type, options, dump, pass] = fields;
  let domain = '';
  if (source === dataProfiles || target === appProfiles) domain = 'profiles';
  if (source === dataState || target === appState) {
    if (domain) throw new Error(`cross-domain runtime fstab line ${index + 1}: ${raw}`);
    domain = 'state';
  }
  if (source === dataOutputs || target === appOutputs) {
    if (domain) throw new Error(`cross-domain runtime fstab line ${index + 1}: ${raw}`);
    domain = 'outputs';
  }
  if (!domain) throw new Error(`partial runtime fstab path match ${index + 1}: ${raw}`);
  const expectedSource = {profiles: dataProfiles, state: dataState, outputs: dataOutputs}[domain];
  const expectedTarget = {profiles: appProfiles, state: appState, outputs: appOutputs}[domain];
  if (source !== expectedSource || target !== expectedTarget || type !== 'none' || dump !== '0' || pass !== '0') {
    throw new Error(`non-exact ${domain} fstab line ${index + 1}: ${raw}`);
  }
  records[domain].push({index, options, raw});
}

for (const domain of Object.keys(records)) {
  if (records[domain].length > 1) throw new Error(`duplicate ${domain} fstab lines`);
}
const profile = records.profiles[0];
const state = records.state[0];
const outputs = records.outputs[0];
const legacy = Boolean(profile && legacyProfileOptions.has(profile.options)
  && !state && outputs && legacyProfileOptions.has(outputs.options));
const desired = Boolean(profile && desiredProfileOptions.has(profile.options)
  && state && desiredProfileOptions.has(state.options) && !outputs);
if (!legacy && !desired) {
  throw new Error(`runtime fstab layout is neither exact legacy nor exact v2: ${JSON.stringify({profiles: records.profiles, state: records.state, outputs: records.outputs})}`);
}
if (action === 'mode') {
  process.stdout.write(legacy ? 'legacy' : 'v2');
} else if (action === 'content') {
  if (legacy) {
    lines[profile.index] = `${dataProfiles} ${appProfiles} none ${desiredOptions(profile)} 0 0`;
    lines[outputs.index] = `${dataState} ${appState} none ${desiredOptions(outputs)} 0 0`;
  }
  process.stdout.write(lines.join('\n') + (finalNewline ? '\n' : ''));
} else {
  throw new Error(`unsupported fstab transform action: ${action}`);
}
// FSTAB_TRANSFORM_END
NODE_FSTAB
}

read_maintenance_gate() {
  node --input-type=module - "$MAINTENANCE_MARKER" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [configuredFile] = process.argv.slice(2);
const file = path.resolve(configuredFile);
const canonicalControlDir = '/var/lib/shein-bi-control';
const canonicalFile = `${canonicalControlDir}/cloud-maintenance.json`;
let raw;

if (file === canonicalFile) {
  for (const [dir, exactMode] of [
    ['/', null],
    ['/var', null],
    ['/var/lib', null],
    [canonicalControlDir, 0o755],
  ]) {
    const ancestor = fs.lstatSync(dir);
    const mode = ancestor.mode & 0o777;
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
      || ancestor.uid !== 0 || ancestor.gid !== 0 || (mode & 0o022) !== 0
      || (exactMode !== null && mode !== exactMode)) {
      throw new Error(`canonical maintenance ancestor is unsafe: ${JSON.stringify({
        dir,
        directory: ancestor.isDirectory(),
        symlink: ancestor.isSymbolicLink(),
        uid: ancestor.uid,
        gid: ancestor.gid,
        mode: mode.toString(8),
        exactMode: exactMode === null ? null : exactMode.toString(8),
      })}`);
    }
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (fs.constants.O_NONBLOCK || 0);
  const fd = fs.openSync(file, flags);
  try {
    const stat = fs.fstatSync(fd);
    const mode = stat.mode & 0o777;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== 0 || stat.gid !== 0 || mode !== 0o644) {
      throw new Error(`canonical maintenance marker metadata is unsafe: ${JSON.stringify({
        regular: stat.isFile(),
        symlink: stat.isSymbolicLink(),
        nlink: stat.nlink,
        uid: stat.uid,
        gid: stat.gid,
        mode: mode.toString(8),
      })}`);
    }
    if (stat.size < 1 || stat.size > 64 * 1024) {
      throw new Error(`canonical maintenance marker size is unsafe: ${stat.size}`);
    }
    raw = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
} else {
  // Fixture/custom paths retain the legacy compatibility contract. Production
  // real mode is bound above to the single canonical root-owned marker.
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('maintenance marker must be a regular non-symlink file');
  }
  raw = fs.readFileSync(file, 'utf8');
}

const value = JSON.parse(raw);
if (value.schemaVersion !== 'cloud-maintenance-mode/v1' || value.active !== true
  || value.mode !== 'all' || !Number.isSafeInteger(value.generation) || value.generation < 1) {
  throw new Error(`maintenance marker must be active mode=all with a positive generation: ${JSON.stringify({
    schemaVersion: value.schemaVersion,
    active: value.active,
    mode: value.mode,
    generation: value.generation,
  })}`);
}
process.stdout.write(String(value.generation));
NODE
}

namespace_audit() {
  local output
  output="$({ /usr/bin/env bash "$NAMESPACE_INSTALLER" --root "$ROOT" --systemd-dir "$SYSTEMD_DIR"; } 2>&1)" \
    || fail "namespace installer audit failed: $output"
  node --input-type=module - "$output" <<'NODE'
const [raw] = process.argv.slice(2);
const value = JSON.parse(raw);
if (value.ok !== true || value.mode !== 'audit' || !Number.isInteger(value.policyCount)
  || value.policyCount < 1 || value.plannedInstall !== 0 || value.unchanged !== value.policyCount) {
  throw new Error(`namespace installer is not fully settled: ${raw}`);
}
process.stdout.write(String(value.policyCount));
NODE
}

maintenance_guard_audit() {
  local output
  output="$({ /usr/bin/env bash "$MAINTENANCE_INSTALLER" --systemd-root "$SYSTEMD_DIR"; } 2>&1)" \
    || fail "maintenance guard installer audit failed: $output"
  node --input-type=module - "$output" <<'NODE'
const [raw] = process.argv.slice(2);
const value = JSON.parse(raw);
if (value.ok !== true || value.mode !== 'audit' || !Number.isInteger(value.policyCount)
  || value.policyCount < 1 || value.plannedInstall !== 0 || value.plannedReplace !== 0
  || value.plannedRemove !== 0 || value.unchanged !== value.policyCount) {
  throw new Error(`maintenance guard installer is not fully settled: ${raw}`);
}
process.stdout.write(String(value.policyCount));
NODE
}

assert_all_services_inactive() {
  local listing service state
  listing="$({ "$SYSTEMCTL_BIN" list-unit-files --type=service --no-legend 'shein-bi-*.service'; } 2>&1)" \
    || fail "cannot enumerate installed shein-bi services: $listing"
  mapfile -t installed_services < <(printf '%s\n' "$listing" | awk '{print $1}' | sed '/^$/d' | sort -u)
  (( ${#installed_services[@]} > 0 )) || fail 'no installed shein-bi services were discovered'
  for service in "${installed_services[@]}"; do
    [[ "$service" =~ ^shein-bi-[A-Za-z0-9_.@-]+\.service$ ]] \
      || fail "unexpected service name from systemctl: $service"
    set +e
    state="$({ "$SYSTEMCTL_BIN" is-active "$service"; } 2>/dev/null)"
    status=$?
    set -e
    [[ "$status" -ne 0 && "$state" == 'inactive' ]] \
      || fail "all shein-bi services must be exactly inactive: $service state=${state:-unknown} exit=$status"
    [[ -f "$SYSTEMD_DIR/$service.d/50-runtime-paths.conf" \
      && ! -L "$SYSTEMD_DIR/$service.d/50-runtime-paths.conf" ]] \
      || fail "installed service lacks an exact runtime path namespace policy: $service"
    [[ -f "$ROOT/infra/systemd/$service" && ! -L "$ROOT/infra/systemd/$service" ]] \
      || fail "installed service has no repository service source audited by maintenance policy: $service"
  done
  printf '%d\n' "${#installed_services[@]}"
}

assert_effective_systemd_controls() {
  local scope="$1"
  local label="$2"
  local show_output validation_output
  [[ "$scope" == guards || "$scope" == all ]] || fail "unsupported effective control scope: $scope"
  (( ${#installed_services[@]} > 0 )) || fail "effective systemd readback has no installed services at $label"
  show_output="$({
    "$SYSTEMCTL_BIN" show "${installed_services[@]}" --no-pager \
      --property=Id,LoadState,ActiveState,SubState,Result,StateChangeTimestamp,ActiveEnterTimestamp,ExecMainCode,ExecMainStatus,ExecMainStartTimestamp,ExecMainExitTimestamp,NRestarts,ExecCondition,RequiresMountsFor,BindPaths,BindReadOnlyPaths,ReadOnlyPaths,InaccessiblePaths
  })" || fail "effective systemd property query failed at $label"
  validation_output="$({
    EFFECTIVE_SYSTEMD_SHOW="$show_output" node --input-type=module - \
      "$RUNTIME_INVENTORY_MODULE" "$RUNTIME_SNAPSHOT_MODULE" \
      "$SYSTEMD_SNAPSHOT_MODULE" \
      "$scope" "$label" "${installed_services[@]}" <<'NODE_EFFECTIVE_SYSTEMD'
import {pathToFileURL} from 'node:url';

const [inventoryFile, runtimeSnapshotFile, systemdSnapshotFile,
  scope, label, ...installedServices] = process.argv.slice(2);
const inventory = await import(pathToFileURL(inventoryFile).href);
const runtimeSnapshot = await import(pathToFileURL(runtimeSnapshotFile).href);
const systemdSnapshot = await import(pathToFileURL(systemdSnapshotFile).href);
const expectedServices = [...inventory.CLOUD_EXPECTED_SERVICE_UNITS].sort();
const installed = [...new Set(installedServices)].sort();
if (expectedServices.length !== 28) {
  throw new Error(`effective control policy must bind exactly 28 services, got ${expectedServices.length}`);
}
if (installed.length !== expectedServices.length
  || installed.some((service, index) => service !== expectedServices[index])) {
  throw new Error(`installed service inventory differs from the 28-service policy at ${label}: ${JSON.stringify({expectedServices, installed})}`);
}
const raw = String(process.env.EFFECTIVE_SYSTEMD_SHOW || '');
const units = systemdSnapshot.parseSystemdShowMany(raw, expectedServices, {code: 0});
const nonInactive = expectedServices
  .filter(service => units[service]?.ActiveState !== 'inactive')
  .map(service => ({service, activeState: units[service]?.ActiveState || 'unknown'}));
if (nonInactive.length) {
  throw new Error(`effective service inactivity validation failed at ${label}: ${JSON.stringify(nonInactive)}`);
}
const guardValidation = inventory.validateCloudMaintenanceEffectiveGuards(units);
if (!guardValidation.ok || guardValidation.checkedServiceCount !== expectedServices.length) {
  throw new Error(`effective ExecCondition validation failed at ${label}: ${JSON.stringify(guardValidation)}`);
}
if (scope === 'all') {
  const runtimeValidation = runtimeSnapshot.validateCloudRuntimeEffectiveControls(units);
  if (!runtimeValidation.ok || runtimeValidation.checkedServiceCount !== expectedServices.length) {
    throw new Error(`effective runtime path validation failed at ${label}: ${JSON.stringify(runtimeValidation)}`);
  }
  // RequiresMountsFor is intentionally a minimum-set contract. systemd adds
  // legitimate implicit dependencies for base-unit paths such as
  // WorkingDirectory and PrivateTmp, while older reviewed units may also have
  // explicit non-runtime dependencies. The validator above still fails closed
  // when any canonical runtime mount is missing. Namespace access properties
  // remain exact because an extra BindPaths/BindReadOnlyPaths/ReadOnlyPaths/
  // InaccessiblePaths token changes the service's filesystem view.
}
process.stdout.write(JSON.stringify({
  ok: true,
  scope,
  label,
  checkedServiceCount: expectedServices.length,
}));
NODE_EFFECTIVE_SYSTEMD
  } 2>&1)" || fail "effective systemd controls are not exact at $label: $validation_output"
  [[ -n "$validation_output" ]] || fail "effective systemd validation returned no evidence at $label"
}

assert_critical_effective_gate() {
  local label="$1"
  local scope="${2:-guards}"
  local generation
  generation="$(read_maintenance_gate)" || fail "maintenance marker validation failed at $label"
  [[ "$generation" == "$maintenance_generation" ]] \
    || fail "maintenance marker generation drifted at $label"
  assert_effective_systemd_controls "$scope" "$label"
}

assert_no_chrome() {
  local process_name
  for process_name in chrome chromium chromium-browser google-chrome google-chrome-stable chrome_crashpad_handler chromedriver; do
    if "$PGREP_BIN" -x "$process_name" >/dev/null 2>&1; then
      fail "Chrome process is still running: $process_name"
    fi
  done
}

assert_real_data_mount() {
  local data_mount info target fstype extra
  data_mount="$(dirname -- "$DATA_ROOT")"
  info="$({ "$FINDMNT_BIN" -rn -o TARGET,FSTYPE --target "$data_mount"; } 2>&1)" \
    || fail "cannot verify data mount: $info"
  IFS=' ' read -r target fstype extra <<<"$info"
  [[ "$target" == "$data_mount" && -n "$fstype" && -z "${extra:-}" ]] \
    || fail "data root must resolve to an exact dedicated mount: $info"
  [[ "$fstype" != rootfs && "$fstype" != overlay && "$fstype" != tmpfs ]] \
    || fail "data root filesystem is not a persistent data mount: $fstype"
}

mount_options() {
  "$FINDMNT_BIN" -rn -o OPTIONS --target "$1"
}

assert_read_only_mount() {
  local target="$1"
  local options
  is_mountpoint "$target" || fail "expected mountpoint is absent: $target"
  options="$(mount_options "$target")" || fail "cannot inspect mount options: $target"
  [[ ",$options," == *,ro,* ]] || fail "mount is not read-only: $target options=$options"
}

assert_read_write_mount() {
  local target="$1"
  local options
  is_mountpoint "$target" || fail "expected mountpoint is absent: $target"
  options="$(mount_options "$target")" || fail "cannot inspect mount options: $target"
  [[ ",$options," == *,rw,* ]] || fail "mount is not read-write: $target options=$options"
}

systemctl_show_value() {
  local property="$1"
  local unit="$2"
  "$SYSTEMCTL_BIN" show --property="$property" --value "$unit"
}

assert_generated_mount_contract() {
  local profiles_unit state_unit outputs_unit load_state requires service required
  profiles_unit="$({ "$SYSTEMD_ESCAPE_BIN" --path --suffix=mount "$APP_PROFILES"; } 2>&1)" \
    || fail "cannot derive profiles mount unit: $profiles_unit"
  state_unit="$({ "$SYSTEMD_ESCAPE_BIN" --path --suffix=mount "$APP_STATE"; } 2>&1)" \
    || fail "cannot derive state mount unit: $state_unit"
  outputs_unit="$({ "$SYSTEMD_ESCAPE_BIN" --path --suffix=mount "$APP_OUTPUTS"; } 2>&1)" \
    || fail "cannot derive outputs mount unit: $outputs_unit"
  load_state="$(systemctl_show_value LoadState "$profiles_unit")" \
    || fail "cannot parse generated profiles mount unit: $profiles_unit"
  [[ "$load_state" == loaded ]] || fail "generated profiles mount unit is not loaded: $profiles_unit state=$load_state"
  load_state="$(systemctl_show_value LoadState "$state_unit")" \
    || fail "cannot parse generated state mount unit: $state_unit"
  [[ "$load_state" == loaded ]] || fail "generated state mount unit is not loaded: $state_unit state=$load_state"
  load_state="$(systemctl_show_value LoadState "$outputs_unit")" \
    || fail "cannot parse generated outputs mount unit state: $outputs_unit"
  [[ "$load_state" == not-found ]] \
    || fail "v2 fstab unexpectedly retains an outputs mount unit: $outputs_unit state=$load_state"
  for service in "${installed_services[@]}"; do
    requires="$(systemctl_show_value RequiresMountsFor "$service")" \
      || fail "cannot parse RequiresMountsFor for installed service: $service"
    for required in "$DATA_PROFILES" "$DATA_STATE" "$DATA_OUTPUTS"; do
      [[ " $requires " == *" $required "* ]] \
        || fail "installed service RequiresMountsFor is missing $required: $service value=$requires"
    done
  done
}

tracked_output_count() {
  "$GIT_BIN" -C "$ROOT" ls-files -z -- outputs | node -e \
    "let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{const v=Buffer.concat(b);process.stdout.write(String(v.length?v.toString('utf8').split('\\0').filter(Boolean).length:0))})"
}

assert_git_outputs_clean() {
  local status
  status="$({ "$GIT_BIN" -C "$ROOT" status --porcelain --untracked-files=no -- outputs; } 2>&1)" \
    || fail "cannot verify tracked outputs status: $status"
  [[ -z "$status" ]] || fail "tracked outputs differ from the current Git index: $status"
}

assert_no_source_tree_backups() {
  local -a legacy_backups=()
  shopt -s nullglob
  legacy_backups=(
    "$ROOT"/state.pre-runtime-layout-v2-*.bak
    "$ROOT"/outputs.git-underlay-pre-runtime-layout-v2-*.bak
  )
  shopt -u nullglob
  (( ${#legacy_backups[@]} == 0 )) \
    || fail "layout migration backups are forbidden in the application source tree: ${legacy_backups[*]}"
}

run_layout_topological_asserts() {
  if [[ "$fstab_layout" == legacy ]]; then
    assert_read_write_mount "$APP_PROFILES"
    assert_read_write_mount "$APP_OUTPUTS"
    ! is_mountpoint "$APP_STATE" || fail 'legacy state path must not already be mounted'
    [[ ! -e "$DATA_STATE" && ! -L "$DATA_STATE" ]] || fail 'legacy migration requires canonical state path to be absent'
    if ((!FIXTURE)); then
      [[ "$(stat -Lc '%d:%i' "$DATA_PROFILES")" == "$(stat -Lc '%d:%i' "$APP_PROFILES")" ]] \
        || fail 'profiles bind does not resolve to the canonical source'
      [[ "$(stat -Lc '%d:%i' "$DATA_OUTPUTS")" == "$(stat -Lc '%d:%i' "$APP_OUTPUTS")" ]] \
        || fail 'outputs bind does not resolve to the canonical source'
    fi
  else
    assert_real_directory "$DATA_STATE" 'canonical state path'
    assert_read_only_mount "$APP_PROFILES"
    assert_read_only_mount "$APP_STATE"
    ! is_mountpoint "$APP_OUTPUTS" || fail 'v2 forbids any host mount on tracked outputs'
    assert_git_outputs_clean
  fi
}

assert_atomic_backup_device() {
  local source="$1"
  local source_device backup_device
  source_device="$(stat -Lc '%d' -- "$source")" || fail "cannot read source device for atomic backup: $source"
  backup_device="$(stat -Lc '%d' -- "$BACKUP_RUN_DIR")" || fail 'cannot read backup run device'
  [[ "$source_device" == "$backup_device" ]] \
    || fail "atomic backup requires the same device: source=$source sourceDevice=$source_device backupDevice=$backup_device"
}
write_backup_status() {
  local status="$1"
  local message="$2"
  [[ -d "$BACKUP_RUN_DIR" && ! -L "$BACKUP_RUN_DIR" ]] || return 0
  local target="$BACKUP_RUN_DIR/migration-status.json"
  STATUS="$status" MESSAGE="$message" STAMP="$STAMP" \
    node --input-type=module - "$ATOMIC_PUBLISH_MODULE" "$target" <<'NODE'
import {pathToFileURL} from 'node:url';
const [atomicModule, file] = process.argv.slice(2);
const {writeJsonFileAtomic} = await import(pathToFileURL(atomicModule).href);
await writeJsonFileAtomic(file, {
  schemaVersion: 'cloud-runtime-layout-migration-status/v1',
  stamp: process.env.STAMP,
  status: process.env.STATUS,
  message: process.env.MESSAGE,
  recordedAt: new Date().toISOString(),
}, {mode: 0o600});
NODE
}

journal_write() {
  local phase="$1"
  local target="$BACKUP_RUN_DIR/migration-journal.json"
  [[ -d "$BACKUP_RUN_DIR" && ! -L "$BACKUP_RUN_DIR" ]] || return 1
  J_STAMP="$STAMP" J_PHASE="$phase" J_ROOT="$ROOT" J_DATA_ROOT="$DATA_ROOT" \
    J_FSTAB="$FSTAB" J_BACKUP_ROOT="$BACKUP_ROOT" J_BACKUP_RUN_DIR="$BACKUP_RUN_DIR" \
    J_SOURCE_FSTAB_HASH="${FSTAB_SOURCE_HASH:-}" J_FSTAB_BACKUP_HASH="${FSTAB_BACKUP_HASH:-}" \
    J_STATE_SOURCE_FP="${STATE_SOURCE_FP:-}" J_OUTPUTS_SOURCE_FP="${OUTPUTS_SOURCE_FP:-}" \
    J_EXPECTED_FSTAB_V2_HASH="${EXPECTED_FSTAB_V2_HASH:-}" J_FSTAB_STAGE_PATH="${FSTAB_STAGE_PATH:-}" \
    J_KNOWN_PHASES="$KNOWN_PHASES" \
    node --input-type=module - "$ATOMIC_PUBLISH_MODULE" "$target" <<'NODE'
import {pathToFileURL} from 'node:url';
const [atomicModule, file] = process.argv.slice(2);
const {writeJsonFileAtomic} = await import(pathToFileURL(atomicModule).href);
const pick = {
  sourceFstabHash: process.env.J_SOURCE_FSTAB_HASH || undefined,
  fstabBackupHash: process.env.J_FSTAB_BACKUP_HASH || undefined,
  stateSourceFingerprint: process.env.J_STATE_SOURCE_FP || undefined,
  outputsSourceFingerprint: process.env.J_OUTPUTS_SOURCE_FP || undefined,
  expectedFstabV2Hash: process.env.J_EXPECTED_FSTAB_V2_HASH || undefined,
  fstabStagePath: process.env.J_FSTAB_STAGE_PATH || undefined,
};
const fingerprints = Object.fromEntries(Object.entries(pick).filter(([, value]) => value !== undefined));
const payload = {
  schemaVersion: 'cloud-runtime-layout-migration-journal/v2',
  intent: 'legacy-to-v2',
  stamp: process.env.J_STAMP,
  phase: process.env.J_PHASE,
  paths: {
    root: process.env.J_ROOT,
    dataRoot: process.env.J_DATA_ROOT,
    fstab: process.env.J_FSTAB,
    backupRoot: process.env.J_BACKUP_ROOT,
    backupRunDir: process.env.J_BACKUP_RUN_DIR,
  },
  fingerprints,
  updatedAt: new Date().toISOString(),
};
await writeJsonFileAtomic(file, payload, {mode: 0o600});
NODE
}

journal_read_meta() {
  local target="$BACKUP_RUN_DIR/migration-journal.json"
  J_ROOT="$ROOT" J_DATA_ROOT="$DATA_ROOT" J_FSTAB="$FSTAB" J_BACKUP_ROOT="$BACKUP_ROOT" \
    J_BACKUP_RUN_DIR="$BACKUP_RUN_DIR" \
    J_KNOWN_PHASES="$KNOWN_PHASES" \
    node --input-type=module - "$target" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [file] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (raw.schemaVersion !== 'cloud-runtime-layout-migration-journal/v2') throw new Error(`migration journal schema mismatch: ${raw.schemaVersion}`);
const p = raw.paths || {};
if (p.root !== process.env.J_ROOT || p.dataRoot !== process.env.J_DATA_ROOT
  || p.fstab !== process.env.J_FSTAB || p.backupRoot !== process.env.J_BACKUP_ROOT) {
  throw new Error('migration journal path bindings conflict with current configuration');
}
if (typeof raw.stamp !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.stamp)) {
  throw new Error('migration journal stamp is unsafe');
}
if (typeof p.backupRunDir !== 'string' || p.backupRunDir !== process.env.J_BACKUP_RUN_DIR
  || p.backupRunDir !== `${process.env.J_BACKUP_ROOT}/${raw.stamp}`
  || path.basename(p.backupRunDir) !== raw.stamp) {
  throw new Error('migration journal run-directory binding conflict');
}
const phases = process.env.J_KNOWN_PHASES.split('|');
if (!phases.includes(raw.phase)) throw new Error(`migration journal has unknown phase: ${raw.phase}`);
const fields = [
  raw.phase,
  raw.fingerprints?.sourceFstabHash ?? '',
  raw.fingerprints?.fstabBackupHash ?? '',
  raw.fingerprints?.stateSourceFingerprint ?? '',
  raw.fingerprints?.outputsSourceFingerprint ?? '',
  raw.fingerprints?.expectedFstabV2Hash ?? '',
  raw.fingerprints?.fstabStagePath ?? '',
];
const allowedFingerprintFields = new Set([
  'sourceFstabHash', 'fstabBackupHash', 'stateSourceFingerprint',
  'outputsSourceFingerprint', 'expectedFstabV2Hash', 'fstabStagePath',
]);
for (const [name, value] of Object.entries(raw.fingerprints || {})) {
  if (!allowedFingerprintFields.has(name)) throw new Error(`migration journal fingerprint field is unknown: ${name}`);
  if (name === 'fstabStagePath') continue;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`migration journal fingerprint is invalid: ${name}`);
  }
}
const stagePath = raw.fingerprints?.fstabStagePath ?? '';
if (stagePath) {
  const expectedParent = path.dirname(process.env.J_FSTAB);
  if (!path.isAbsolute(stagePath) || path.dirname(stagePath) !== expectedParent
    || !/^\.fstab\.runtime-layout-v2\.[A-Za-z0-9._-]+$/.test(path.basename(stagePath))) {
    throw new Error('migration journal fstab stage path is unsafe');
  }
}
for (const value of fields) {
  if (typeof value === 'string' && (value.includes('\t') || value.includes('\n'))) {
    throw new Error('migration journal contains a field with an invalid separator');
  }
}
process.stdout.write(fields.join('\t'));
NODE
}

read_journal_phase() {
  local file="$1"
  node --input-type=module - "$file" <<'NODE'
import fs from 'node:fs';
const [file] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (raw.schemaVersion !== 'cloud-runtime-layout-migration-journal/v2') throw new Error(`migration journal schema mismatch: ${raw.schemaVersion}`);
process.stdout.write(String(raw.phase));
NODE
}

read_status_field() {
  local status_file="$1"
  local key="$2"
  S_KEY="$key" node --input-type=module - "$status_file" <<'NODE'
import fs from 'node:fs';
const [file] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const value = raw[process.env.S_KEY];
process.stdout.write(value === undefined ? '' : String(value));
NODE
}

ROLLBACK_KNOWN_PHASES='rollback-started|rollback-fstab|rollback-state-unmounted|rollback-outputs-restored|rollback-state-restored|rollback-mounts-restored|rollback-cleanup-done|rollback-verified'

rollback_marker_write() {
  local phase="$1"
  local target="$BACKUP_RUN_DIR/migration-rollback.json"
  [[ -d "$BACKUP_RUN_DIR" && ! -L "$BACKUP_RUN_DIR" ]] || return 1
  RB_STAMP="$STAMP" RB_PHASE="$phase" RB_BACKUP_ROOT="$BACKUP_ROOT" \
    RB_BACKUP_RUN_DIR="$BACKUP_RUN_DIR" \
    node --input-type=module - "$ATOMIC_PUBLISH_MODULE" "$target" <<'NODE'
import {pathToFileURL} from 'node:url';
const [atomicModule, file] = process.argv.slice(2);
const {writeJsonFileAtomic} = await import(pathToFileURL(atomicModule).href);
await writeJsonFileAtomic(file, {
  schemaVersion: 'cloud-runtime-layout-migration-rollback/v1',
  stamp: process.env.RB_STAMP,
  rollbackPhase: process.env.RB_PHASE,
  paths: {
    backupRoot: process.env.RB_BACKUP_ROOT,
    backupRunDir: process.env.RB_BACKUP_RUN_DIR,
  },
  updatedAt: new Date().toISOString(),
}, {mode: 0o600});
NODE
}

rollback_marker_read_phase() {
  local target="$BACKUP_RUN_DIR/migration-rollback.json"
  [[ -f "$target" && ! -L "$target" ]] || return 1
  RB_STAMP="$STAMP" RB_BACKUP_ROOT="$BACKUP_ROOT" RB_BACKUP_RUN_DIR="$BACKUP_RUN_DIR" \
    RB_KNOWN_PHASES="$ROLLBACK_KNOWN_PHASES" \
    node --input-type=module - "$target" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [file] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
if (raw.schemaVersion !== 'cloud-runtime-layout-migration-rollback/v1') throw new Error(`rollback marker schema mismatch: ${raw.schemaVersion}`);
const p = raw.paths || {};
if (p.backupRoot !== process.env.RB_BACKUP_ROOT || p.backupRunDir !== process.env.RB_BACKUP_RUN_DIR) {
  throw new Error('rollback marker path bindings conflict with current configuration');
}
if (typeof raw.stamp !== 'string' || raw.stamp !== process.env.RB_STAMP
  || !/^[A-Za-z0-9._-]{1,128}$/.test(raw.stamp)) {
  throw new Error('rollback marker stamp is unsafe');
}
if (typeof p.backupRunDir !== 'string' || p.backupRunDir !== `${process.env.RB_BACKUP_ROOT}/${raw.stamp}`
  || path.basename(p.backupRunDir) !== raw.stamp) {
  throw new Error('rollback marker run-directory binding conflict');
}
const phases = process.env.RB_KNOWN_PHASES.split('|');
if (typeof raw.rollbackPhase !== 'string' || !phases.includes(raw.rollbackPhase)) {
  throw new Error(`rollback marker has unknown phase: ${String(raw.rollbackPhase)}`);
}
process.stdout.write(raw.rollbackPhase);
NODE
}

safe_delete_created_tree() {
  local target="$1"
  case "$target" in
    "$STATE_STAGING"|"$DATA_STATE"|"$APP_OUTPUTS"|"$APP_STATE") ;;
    *) printf 'rollback_refused_unsafe_delete=%s\n' "$target" >&2; return 1 ;;
  esac
  [[ -d "$target" && ! -L "$target" ]] || return 0
  if is_mountpoint "$target"; then
    printf 'rollback_refused_mounted_delete=%s\n' "$target" >&2
    return 1
  fi
  find "$target" -xdev -depth -mindepth 1 -delete
  rmdir -- "$target"
}

migration_failpoint() {
  local label="$1"
  if [[ "${SHEIN_BI_MIGRATION_FAILPOINT:-}" == "$label" ]]; then
    printf 'runtime_layout_failpoint=%s\n' "$label" >&2
    kill -9 $$
  fi
}

assert_disposable_reconstructed_outputs() {
  local status
  [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] \
    || fail 'rollback requires reconstructed outputs to be a real directory'
  ! is_mountpoint "$APP_OUTPUTS" \
    || fail 'rollback refuses a mounted reconstructed outputs path'
  status="$({ "$GIT_BIN" -C "$ROOT" status --porcelain --untracked-files=all -- outputs; } 2>&1)" \
    || fail "rollback cannot validate reconstructed outputs: $status"
  [[ -z "$status" ]] \
    || fail "rollback refuses changed or untracked reconstructed outputs: $status"
}

assert_empty_unmounted_directory() {
  local target="$1"
  local label="$2"
  local first
  [[ -d "$target" && ! -L "$target" ]] || fail "$label must be a real directory"
  ! is_mountpoint "$target" || return 0
  first="$(find "$target" -xdev -mindepth 1 -print -quit 2>/dev/null)" \
    || fail "cannot inspect $label"
  [[ -z "$first" ]] || fail "$label contains unreviewed data: $first"
}

prevalidate_rollback_evidence() {
  local require_fstab_backup=0 require_data_state=0 require_outputs_fingerprint=0
  local require_outputs_backup=0 require_state_backup=0 require_expected_fstab=0
  local current_hash backup_hash='' fp='' options stage_hash status
  [[ "$FSTAB_SOURCE_HASH" =~ ^[0-9a-f]{64}$ ]] \
    || fail "rollback journal phase $PHASE lacks source fstab evidence"
  [[ "$STATE_SOURCE_FP" =~ ^[0-9a-f]{64}$ ]] \
    || fail "rollback journal phase $PHASE lacks state source evidence"
  case "$PHASE" in
    init) ;;
    fstab-backed-up)
      require_fstab_backup=1
      ;;
    state-data-created)
      require_fstab_backup=1
      require_data_state=1
      ;;
    outputs-underlay-prepared)
      require_fstab_backup=1
      require_data_state=1
      require_outputs_fingerprint=1
      ;;
    outputs-underlay-moved)
      require_fstab_backup=1
      require_data_state=1
      require_outputs_fingerprint=1
      require_outputs_backup=1
      ;;
    state-underlay-moved|readonly-mounts-done)
      require_fstab_backup=1
      require_data_state=1
      require_outputs_fingerprint=1
      require_outputs_backup=1
      require_state_backup=1
      ;;
    fstab-publish-prepared|fstab-published)
      require_fstab_backup=1
      require_data_state=1
      require_outputs_fingerprint=1
      require_outputs_backup=1
      require_state_backup=1
      require_expected_fstab=1
      ;;
    *) fail "rollback is not supported from journal phase: $PHASE" ;;
  esac

  current_hash="$(sha256_file "$FSTAB")" || fail 'rollback cannot hash current fstab'
  if ((require_expected_fstab)); then
    [[ "$EXPECTED_FSTAB_V2_HASH" =~ ^[0-9a-f]{64}$ ]] \
      || fail "rollback journal phase $PHASE lacks expected v2 fstab evidence"
  fi
  case "$PHASE" in
    fstab-published)
      [[ "$current_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
        || fail 'rollback current fstab does not match the published v2 journal evidence'
      ;;
    fstab-publish-prepared)
      [[ "$current_hash" == "$FSTAB_SOURCE_HASH" || "$current_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
        || fail 'rollback current fstab matches neither source nor prepared v2 evidence'
      ;;
    *)
      [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] \
        || fail "rollback current fstab drifted before phase $PHASE"
      ;;
  esac

  if ((require_fstab_backup)) || [[ -e "$FSTAB_BACKUP" || -L "$FSTAB_BACKUP" ]]; then
    [[ -f "$FSTAB_BACKUP" && ! -L "$FSTAB_BACKUP" ]] \
      || fail "rollback journal phase $PHASE requires an exact fstab backup"
    [[ "$FSTAB_BACKUP_HASH" =~ ^[0-9a-f]{64}$ ]] \
      || fail "rollback journal phase $PHASE lacks the fstab backup hash"
    backup_hash="$(sha256_file "$FSTAB_BACKUP")" || fail 'rollback cannot hash fstab backup'
    [[ "$backup_hash" == "$FSTAB_SOURCE_HASH" && "$backup_hash" == "$FSTAB_BACKUP_HASH" ]] \
      || fail "rollback fstab backup evidence mismatch: source=$FSTAB_SOURCE_HASH journal=$FSTAB_BACKUP_HASH actual=$backup_hash"
    [[ "$(file_owner_mode "$FSTAB_BACKUP")" == "$(file_owner_mode "$FSTAB")" ]] \
      || fail 'rollback fstab owner/mode evidence does not match the current file'
  fi

  if ((require_data_state)); then
    [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]] \
      || fail "rollback journal phase $PHASE requires canonical state data"
    fp="$(tree_fingerprint "$DATA_STATE")" || fail 'rollback cannot fingerprint canonical state data'
    [[ "$fp" == "$STATE_SOURCE_FP" ]] \
      || fail "rollback canonical state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
  elif [[ -e "$DATA_STATE" || -L "$DATA_STATE" ]]; then
    [[ "$PHASE" == fstab-backed-up && -d "$DATA_STATE" && ! -L "$DATA_STATE" ]] \
      || fail "rollback journal phase $PHASE does not authorize canonical state data"
    fp="$(tree_fingerprint "$DATA_STATE")" || fail 'rollback cannot fingerprint early canonical state data'
    [[ "$fp" == "$STATE_SOURCE_FP" ]] \
      || fail "rollback early canonical state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
  fi

  if ((require_state_backup)) || [[ -e "$STATE_BACKUP" || -L "$STATE_BACKUP" ]]; then
    [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]] \
      || fail "rollback journal phase $PHASE requires an exact state underlay backup"
    fp="$(tree_fingerprint "$STATE_BACKUP")" || fail 'rollback cannot fingerprint state underlay backup'
    [[ "$fp" == "$STATE_SOURCE_FP" ]] \
      || fail "rollback state backup evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
    if [[ -e "$APP_STATE" || -L "$APP_STATE" ]]; then
      assert_empty_unmounted_directory "$APP_STATE" 'rollback state replacement path'
    fi
  else
    [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] \
      || fail "rollback journal phase $PHASE requires the original state underlay"
    ! is_mountpoint "$APP_STATE" \
      || fail "rollback journal phase $PHASE unexpectedly mounted the original state path"
    fp="$(tree_fingerprint "$APP_STATE")" || fail 'rollback cannot fingerprint original state underlay'
    [[ "$fp" == "$STATE_SOURCE_FP" ]] \
      || fail "rollback original state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
  fi

  if ((require_outputs_fingerprint)); then
    [[ "$OUTPUTS_SOURCE_FP" =~ ^[0-9a-f]{64}$ ]] \
      || fail "rollback journal phase $PHASE lacks outputs source evidence"
  fi
  if ((require_outputs_backup)) || [[ -e "$OUTPUTS_BACKUP" || -L "$OUTPUTS_BACKUP" ]]; then
    [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]] \
      || fail "rollback journal phase $PHASE requires an exact outputs underlay backup"
    fp="$(tree_fingerprint "$OUTPUTS_BACKUP")" || fail 'rollback cannot fingerprint outputs underlay backup'
    [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] \
      || fail "rollback outputs backup evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
    if [[ -e "$APP_OUTPUTS" || -L "$APP_OUTPUTS" ]]; then
      assert_disposable_reconstructed_outputs
    fi
  elif [[ "$PHASE" == outputs-underlay-prepared ]]; then
    [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] \
      || fail 'rollback requires the revealed outputs underlay'
    ! is_mountpoint "$APP_OUTPUTS" || fail 'rollback outputs-underlay-prepared path must be unmounted'
    fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'rollback cannot fingerprint revealed outputs underlay'
    [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] \
      || fail "rollback revealed outputs evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
  else
    is_mountpoint "$APP_OUTPUTS" \
      || fail "rollback journal phase $PHASE requires the original outputs mount"
    options="$(mount_options "$APP_OUTPUTS")" || fail 'rollback cannot inspect original outputs mount options'
    [[ ",$options," == *,rw,* ]] || fail "rollback original outputs mount is not read-write: $options"
  fi

  is_mountpoint "$APP_PROFILES" || fail 'rollback requires the profiles host mount'
  options="$(mount_options "$APP_PROFILES")" || fail 'rollback cannot inspect profiles mount options'
  [[ ",$options," == *,ro,* || ",$options," == *,rw,* ]] \
    || fail "rollback profiles mount options are unsupported: $options"
  if [[ "$PHASE" =~ ^(readonly-mounts-done|fstab-publish-prepared|fstab-published)$ ]]; then
    [[ ",$options," == *,ro,* ]] || fail "rollback phase $PHASE requires read-only profiles"
    is_mountpoint "$APP_STATE" || fail "rollback phase $PHASE requires the state host mount"
    options="$(mount_options "$APP_STATE")" || fail 'rollback cannot inspect state mount options'
    [[ ",$options," == *,ro,* ]] || fail "rollback phase $PHASE requires read-only state"
  fi

  if [[ -n "$FSTAB_STAGE_PATH" ]]; then
    if [[ "$current_hash" == "$FSTAB_SOURCE_HASH" && "$PHASE" == fstab-publish-prepared ]]; then
      [[ -f "$FSTAB_STAGE_PATH" && ! -L "$FSTAB_STAGE_PATH" ]] \
        || fail 'rollback prepared fstab stage evidence is missing or unsafe'
      stage_hash="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'rollback cannot hash prepared fstab stage'
      [[ "$stage_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
        || fail "rollback prepared fstab stage hash mismatch: expected=$EXPECTED_FSTAB_V2_HASH actual=$stage_hash"
      assert_same_file_owner_mode "$FSTAB_BACKUP" "$FSTAB_STAGE_PATH" 'rollback prepared fstab stage'
    elif [[ -e "$FSTAB_STAGE_PATH" || -L "$FSTAB_STAGE_PATH" ]]; then
      fail "rollback phase $PHASE has an unexpected surviving fstab stage"
    fi
  elif [[ "$current_hash" == "$FSTAB_SOURCE_HASH" && "$PHASE" == fstab-publish-prepared ]]; then
    fail 'rollback prepared fstab stage path evidence is missing'
  fi

  if [[ -e "$STATE_STAGING" || -L "$STATE_STAGING" ]]; then
    [[ "$PHASE" == fstab-backed-up && -d "$STATE_STAGING" && ! -L "$STATE_STAGING" ]] \
      || fail "rollback journal phase $PHASE has an unsafe state staging tree"
  fi
  ROLLBACK_FSTAB_CURRENT_HASH="$current_hash"
  ROLLBACK_FSTAB_BACKUP_HASH="$backup_hash"
  printf 'runtime_layout_rollback_prevalidation=ok phase=%s\n' "$PHASE" >&2
}

prevalidate_rollback_resume() {
  # A resumed rollback owns the journal, so the forward-phase fstab/topology
  # expectations no longer bind. This gate validates that every underlay is in
  # the allowed "pending-or-durable" state for its rollback phase and that the
  # current fstab is one of the rollback-allowed hashes (source or the recorded
  # prepared v2). Any other value is ordinary drift and fails closed before a
  # single rollback mutation re-runs.
  local current_hash backup_hash='' fp='' options=''
  local step=0 forward_cd_state=0 forward_out=0 forward_state=0 forward_reveal=0 forward_ro=0
  case "$ROLLBACK_PHASE" in
    rollback-started) step=0 ;;
    rollback-fstab) step=1 ;;
    rollback-state-unmounted) step=2 ;;
    rollback-outputs-restored) step=3 ;;
    rollback-state-restored) step=4 ;;
    rollback-mounts-restored) step=5 ;;
    rollback-cleanup-done) step=6 ;;
    rollback-verified) step=7 ;;
    *) fail "unsupported rollback phase: $ROLLBACK_PHASE" ;;
  esac
  case "$PHASE" in
    state-data-created|outputs-underlay-prepared|outputs-underlay-moved|state-underlay-moved|readonly-mounts-done|fstab-publish-prepared|fstab-published) forward_cd_state=1 ;;
  esac
  case "$PHASE" in
    outputs-underlay-moved|state-underlay-moved|readonly-mounts-done|fstab-publish-prepared|fstab-published) forward_out=1 ;;
  esac
  case "$PHASE" in
    outputs-underlay-prepared) forward_reveal=1 ;;
  esac
  case "$PHASE" in
    state-underlay-moved|readonly-mounts-done|fstab-publish-prepared|fstab-published) forward_state=1 ;;
  esac
  case "$PHASE" in
    readonly-mounts-done|fstab-publish-prepared|fstab-published) forward_ro=1 ;;
  esac

  [[ "$FSTAB_SOURCE_HASH" =~ ^[0-9a-f]{64}$ ]] || fail 'rollback journal lacks source fstab evidence'
  [[ "$STATE_SOURCE_FP" =~ ^[0-9a-f]{64}$ ]] || fail 'rollback journal lacks state source evidence'
  if ((forward_out || forward_reveal)); then
    [[ "$OUTPUTS_SOURCE_FP" =~ ^[0-9a-f]{64}$ ]] || fail 'rollback journal lacks outputs source evidence'
  fi
  # The fstab backup is immutable: rollback never consumes it.
  [[ -f "$FSTAB_BACKUP" && ! -L "$FSTAB_BACKUP" ]] || fail 'rollback journal requires an exact fstab backup'
  [[ "$FSTAB_BACKUP_HASH" =~ ^[0-9a-f]{64}$ ]] || fail 'rollback journal lacks the fstab backup hash'
  backup_hash="$(sha256_file "$FSTAB_BACKUP")" || fail 'rollback cannot hash fstab backup'
  [[ "$backup_hash" == "$FSTAB_SOURCE_HASH" && "$backup_hash" == "$FSTAB_BACKUP_HASH" ]] \
    || fail "rollback fstab backup evidence mismatch: source=$FSTAB_SOURCE_HASH journal=$FSTAB_BACKUP_HASH actual=$backup_hash"
  current_hash="$(sha256_file "$FSTAB")" || fail 'rollback cannot hash current fstab'
  if ((step >= 1)); then
    [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] \
      || fail "rollback current fstab drifted after restore: expected=$FSTAB_SOURCE_HASH actual=$current_hash"
  else
    case "$PHASE" in
      fstab-publish-prepared|fstab-published)
        [[ "$EXPECTED_FSTAB_V2_HASH" =~ ^[0-9a-f]{64}$ ]] \
          || fail "rollback journal phase $PHASE lacks expected v2 fstab evidence"
        # The restore may still be pending (recorded v2), or the atomic source
        # rename may be durable while the rollback marker still lags at step 0.
        [[ "$current_hash" == "$FSTAB_SOURCE_HASH" || "$current_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
          || fail "rollback current fstab drifted: source=$FSTAB_SOURCE_HASH expected=$EXPECTED_FSTAB_V2_HASH actual=$current_hash"
        ;;
      init|fstab-backed-up|state-data-created|outputs-underlay-prepared|outputs-underlay-moved|state-underlay-moved|readonly-mounts-done)
        [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] \
          || fail "rollback current fstab drifted before phase $PHASE: expected=$FSTAB_SOURCE_HASH actual=$current_hash"
        ;;
      *) fail "rollback cannot validate fstab for journal phase: $PHASE" ;;
    esac
  fi

  # State underlay: original moved only from forward phase >= state-underlay-moved.
  if ((forward_state)); then
    case "$ROLLBACK_PHASE" in
      rollback-started|rollback-fstab|rollback-state-unmounted|rollback-outputs-restored)
        if [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]]; then
          fp="$(tree_fingerprint "$STATE_BACKUP")" || fail 'rollback cannot fingerprint state underlay backup'
          [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback state backup evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
          if [[ -e "$APP_STATE" || -L "$APP_STATE" ]]; then
            [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] || fail 'rollback state replacement path is unsafe'
            assert_empty_unmounted_directory "$APP_STATE" 'rollback state replacement path'
          fi
        elif [[ "$ROLLBACK_PHASE" == rollback-state-unmounted || "$ROLLBACK_PHASE" == rollback-outputs-restored ]]; then
          # crash window: state restore mutation durable, marker lags one step
          [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] || fail 'rollback requires the restored state underlay'
          ! is_mountpoint "$APP_STATE" || fail 'rollback restored state underlay must be unmounted'
          fp="$(tree_fingerprint "$APP_STATE")" || fail 'rollback cannot fingerprint restored state underlay'
          [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback restored state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
        else
          fail "rollback state backup evidence missing at phase $ROLLBACK_PHASE"
        fi
        ;;
      rollback-state-restored|rollback-mounts-restored|rollback-cleanup-done|rollback-verified)
        [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] || fail 'rollback requires the restored state underlay'
        ! is_mountpoint "$APP_STATE" || fail 'rollback restored state underlay must be unmounted'
        fp="$(tree_fingerprint "$APP_STATE")" || fail 'rollback cannot fingerprint restored state underlay'
        [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback restored state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
        ;;
    esac
  else
    [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] || fail 'rollback requires the original state underlay'
    fp="$(tree_fingerprint "$APP_STATE")" || fail 'rollback cannot fingerprint original state underlay'
    [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback original state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
  fi

  # Outputs underlay: original moved only from forward phase >= outputs-underlay-moved.
  if ((forward_out)); then
    case "$ROLLBACK_PHASE" in
      rollback-started|rollback-fstab|rollback-state-unmounted)
        if [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
          fp="$(tree_fingerprint "$OUTPUTS_BACKUP")" || fail 'rollback cannot fingerprint outputs underlay backup'
          [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail "rollback outputs backup evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
          if [[ -e "$APP_OUTPUTS" || -L "$APP_OUTPUTS" ]]; then
            assert_disposable_reconstructed_outputs
          fi
        elif [[ "$ROLLBACK_PHASE" == rollback-state-unmounted ]]; then
          # crash window: outputs restore mutation durable, marker lags one step
          [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] || fail 'rollback requires the restored outputs underlay'
          fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'rollback cannot fingerprint restored outputs underlay'
          [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail "rollback restored outputs evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
        else
          fail "rollback outputs backup evidence missing at phase $ROLLBACK_PHASE"
        fi
        ;;
      rollback-outputs-restored|rollback-state-restored|rollback-mounts-restored|rollback-cleanup-done|rollback-verified)
        [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] || fail 'rollback requires the restored outputs underlay'
        fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'rollback cannot fingerprint restored outputs underlay'
        [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail "rollback restored outputs evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
        ;;
    esac
  elif ((forward_reveal)); then
    [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] || fail 'rollback requires the revealed outputs underlay'
    ! is_mountpoint "$APP_OUTPUTS" || fail 'rollback revealed outputs path must be unmounted'
    fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'rollback cannot fingerprint revealed outputs underlay'
    [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail "rollback revealed outputs evidence mismatch: expected=$OUTPUTS_SOURCE_FP actual=$fp"
  else
    is_mountpoint "$APP_OUTPUTS" || fail 'rollback requires the original outputs host mount'
    options="$(mount_options "$APP_OUTPUTS")" || fail 'rollback cannot inspect outputs mount options'
    [[ ",$options," == *,rw,* ]] || fail "rollback original outputs mount is not read-write: $options"
  fi

  # Canonical state data: deleted only by the cleanup step.
  if ((forward_cd_state)); then
    if ((step < 5)); then
      [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]] || fail "rollback phase $ROLLBACK_PHASE requires canonical state data"
      fp="$(tree_fingerprint "$DATA_STATE")" || fail 'rollback cannot fingerprint canonical state data'
      [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback canonical state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
    elif ((step == 5)); then
      if [[ -e "$DATA_STATE" || -L "$DATA_STATE" ]]; then
        [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]] || fail 'rollback canonical state path is unsafe'
        fp="$(tree_fingerprint "$DATA_STATE")" || fail 'rollback cannot fingerprint canonical state data'
        [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail "rollback canonical state evidence mismatch: expected=$STATE_SOURCE_FP actual=$fp"
      fi
    else
      [[ ! -e "$DATA_STATE" && ! -L "$DATA_STATE" ]] || fail "rollback phase $ROLLBACK_PHASE requires canonical state data removed"
    fi
  fi

  is_mountpoint "$APP_PROFILES" || fail 'rollback requires the profiles host mount'
  options="$(mount_options "$APP_PROFILES")" || fail 'rollback cannot inspect profiles mount options'
  if ((step >= 5)); then
    [[ ",$options," == *,rw,* ]] || fail "rollback phase $ROLLBACK_PHASE requires read-write profiles"
  elif ((step == 4)); then
    # mounts step may be pending (forward read-only) or durable (read-write)
    [[ ",$options," == *,ro,* || ",$options," == *,rw,* ]] \
      || fail "rollback phase $ROLLBACK_PHASE profile mount options are unsupported: $options"
  elif ((forward_ro)); then
    [[ ",$options," == *,ro,* ]] || fail "rollback phase $ROLLBACK_PHASE requires read-only profiles"
  fi

  # The prepared v2 fstab stage is consumed only by the cleanup step. Before the
  # cleanup phase it must still carry the recorded v2 content; after cleanup it
  # must be gone.
  if [[ -n "$FSTAB_STAGE_PATH" && "$PHASE" == fstab-publish-prepared ]]; then
    if [[ "$ROLLBACK_PHASE" == rollback-cleanup-done || "$ROLLBACK_PHASE" == rollback-verified ]]; then
      [[ ! -e "$FSTAB_STAGE_PATH" && ! -L "$FSTAB_STAGE_PATH" ]] \
        || fail "rollback phase $ROLLBACK_PHASE requires the prepared fstab stage removed"
    else
      [[ -f "$FSTAB_STAGE_PATH" && ! -L "$FSTAB_STAGE_PATH" ]] \
        || fail 'rollback prepared fstab stage evidence is missing on resume'
      fp="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'rollback cannot hash prepared fstab stage'
      [[ "$fp" == "$EXPECTED_FSTAB_V2_HASH" ]] \
        || fail "rollback prepared fstab stage hash mismatch on resume: expected=$EXPECTED_FSTAB_V2_HASH actual=$fp"
    fi
  fi

  ROLLBACK_FSTAB_CURRENT_HASH="$current_hash"
  ROLLBACK_FSTAB_BACKUP_HASH="$backup_hash"
  printf 'runtime_layout_rollback_resume_prevalidation=ok phase=%s rollback=%s\n' "$PHASE" "$ROLLBACK_PHASE" >&2
}

atomic_restore_fstab() {
  local parent temp temp_hash expected_meta actual_meta
  parent="$(dirname -- "$FSTAB")"
  temp="$(mktemp "$parent/.fstab.runtime-layout-rollback.XXXXXX")" || return 1
  if ! cp --preserve=all -- "$FSTAB_BACKUP" "$temp"; then
    rm -f -- "$temp"
    return 1
  fi
  temp_hash="$(sha256_file "$temp")" || { rm -f -- "$temp"; return 1; }
  [[ "$temp_hash" == "$ROLLBACK_FSTAB_BACKUP_HASH" ]] || { rm -f -- "$temp"; return 1; }
  expected_meta="$(file_owner_mode "$FSTAB_BACKUP")" || { rm -f -- "$temp"; return 1; }
  actual_meta="$(file_owner_mode "$temp")" || { rm -f -- "$temp"; return 1; }
  [[ "$actual_meta" == "$expected_meta" ]] || { rm -f -- "$temp"; return 1; }
  sync -f -- "$temp" || { rm -f -- "$temp"; return 1; }
  migration_failpoint 'before-rollback-fstab-atomic-rename'
  mv -- "$temp" "$FSTAB" || { rm -f -- "$temp"; return 1; }
  sync -f -- "$FSTAB" || return 1
  sync -f -- "$parent" || return 1
  [[ "$(sha256_file "$FSTAB")" == "$ROLLBACK_FSTAB_BACKUP_HASH" ]] || return 1
  [[ "$(file_owner_mode "$FSTAB")" == "$expected_meta" ]] || return 1
}

RESTORE_OK=0
restore_legacy() {
  local restore_status=0
  local current_hash='' backup_hash=''
  ((ROLLBACK_RUNNING == 0)) || return 0
  assert_critical_effective_gate 'before-explicit-rollback' all
  if ((ROLLBACK_RESUMING)); then
    ROLLBACK_PHASE="$(rollback_marker_read_phase)" || fail 'rollback marker is unreadable or tampered'
    prevalidate_rollback_resume
  else
    prevalidate_rollback_evidence
    ROLLBACK_PHASE='rollback-started'
    rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; }
    if ((restore_status == 0)); then
      migration_failpoint 'after-rollback-started-marker-before-mutation'
    fi
  fi
  ROLLBACK_RUNNING=1
  ROLLBACK_MUTATION_STARTED=1
  RESTORE_OK=0
  set +e
  printf 'runtime_layout_restore_legacy=starting\n' >&2
  current_hash="$ROLLBACK_FSTAB_CURRENT_HASH"
  backup_hash="$ROLLBACK_FSTAB_BACKUP_HASH"
  while ((restore_status == 0)); do
    case "$ROLLBACK_PHASE" in
      rollback-started)
        # fstab restore step (idempotent: crash-after-rename resumes with fstab already source)
        if [[ -n "$backup_hash" && "$current_hash" != "$backup_hash" ]]; then
          atomic_restore_fstab || { restore_status=1; break; }
          "$SYSTEMCTL_BIN" daemon-reload || { restore_status=1; break; }
          migration_failpoint 'after-rollback-fstab-restore-before-journal'
        fi
        ROLLBACK_PHASE='rollback-fstab'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-fstab)
        # state unmount step (idempotent)
        if is_mountpoint "$APP_STATE"; then
          "$UMOUNT_BIN" -- "$APP_STATE" || { restore_status=1; break; }
          migration_failpoint 'after-rollback-state-unmount-before-journal'
        fi
        ROLLBACK_PHASE='rollback-state-unmounted'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-state-unmounted)
        # outputs restore step (idempotent)
        if [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
          if is_mountpoint "$APP_OUTPUTS"; then "$UMOUNT_BIN" -- "$APP_OUTPUTS" || { restore_status=1; break; }; fi
          if [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]]; then
            safe_delete_created_tree "$APP_OUTPUTS" || { restore_status=1; break; }
          fi
          if [[ ! -e "$APP_OUTPUTS" ]]; then mv -- "$OUTPUTS_BACKUP" "$APP_OUTPUTS" || { restore_status=1; break; }; fi
          migration_failpoint 'after-rollback-outputs-restore-before-journal'
        fi
        ROLLBACK_PHASE='rollback-outputs-restored'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-outputs-restored)
        # state restore step (idempotent)
        if [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]]; then
          if [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]]; then
            safe_delete_created_tree "$APP_STATE" || { restore_status=1; break; }
          fi
          if [[ ! -e "$APP_STATE" ]]; then mv -- "$STATE_BACKUP" "$APP_STATE" || { restore_status=1; break; }; fi
          migration_failpoint 'after-rollback-state-restore-before-journal'
        fi
        ROLLBACK_PHASE='rollback-state-restored'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-state-restored)
        # mounts restore step (idempotent)
        if [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]] && ! is_mountpoint "$APP_OUTPUTS"; then
          "$MOUNT_BIN" -- "$APP_OUTPUTS" || { restore_status=1; break; }
        fi
        if is_mountpoint "$APP_PROFILES"; then
          "$MOUNT_BIN" -o remount,bind,rw -- "$APP_PROFILES" || { restore_status=1; break; }
        else
          "$MOUNT_BIN" -- "$APP_PROFILES" || { restore_status=1; break; }
        fi
        migration_failpoint 'after-rollback-mounts-restore-before-journal'
        ROLLBACK_PHASE='rollback-mounts-restored'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-mounts-restored)
        # cleanup step (idempotent)
        if [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]]; then safe_delete_created_tree "$DATA_STATE" || { restore_status=1; break; }; fi
        if [[ -d "$STATE_STAGING" && ! -L "$STATE_STAGING" ]]; then safe_delete_created_tree "$STATE_STAGING" || { restore_status=1; break; }; fi
        if [[ -n "$FSTAB_STAGE_PATH" && -e "$FSTAB_STAGE_PATH" ]]; then rm -f -- "$FSTAB_STAGE_PATH"; fi
        migration_failpoint 'after-rollback-cleanup-before-journal'
        ROLLBACK_PHASE='rollback-cleanup-done'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-cleanup-done)
        # terminal verification step
        local check=0 po oo
        if [[ -n "$FSTAB_SOURCE_HASH" ]]; then
          [[ "$(sha256_file "$FSTAB")" == "$FSTAB_SOURCE_HASH" ]] || check=1
        fi
        is_mountpoint "$APP_PROFILES" || check=1
        po="$(mount_options "$APP_PROFILES")" || check=1
        [[ ",$po," == *,rw,* ]] || check=1
        [[ -d "$APP_STATE" && ! -L "$APP_STATE" ]] || check=1
        ! is_mountpoint "$APP_STATE" || check=1
        is_mountpoint "$APP_OUTPUTS" || check=1
        oo="$(mount_options "$APP_OUTPUTS")" || check=1
        [[ ",$oo," == *,rw,* ]] || check=1
        [[ ! -e "$DATA_STATE" && ! -L "$DATA_STATE" ]] || check=1
        [[ ! -e "$STATE_STAGING" && ! -L "$STATE_STAGING" ]] || check=1
        if ((check)); then restore_status=1; break; fi
        migration_failpoint 'before-rollback-verified-journal'
        ROLLBACK_PHASE='rollback-verified'
        rollback_marker_write "$ROLLBACK_PHASE" || { restore_status=1; break; }
        ;;
      rollback-verified)
        break
        ;;
      *) restore_status=1; break ;;
    esac
  done
  set -e
  if ((restore_status)); then
    printf 'runtime_layout_restore_legacy=failed_manual_intervention_required\n' >&2
    ROLLBACK_RUNNING=0
    return 1
  fi
  RESTORE_OK=1
  printf 'runtime_layout_restore_legacy=ok\n' >&2
}

on_exit() {
  local status=$?
  if ((status != 0 && COMPLETED == 0 && ROLLBACK_RUNNING == 0 \
    && (APPLY || (ROLLBACK_FLAG && ROLLBACK_MUTATION_STARTED == 1)))) \
    && [[ -n "$BACKUP_RUN_DIR" && -d "$BACKUP_RUN_DIR" ]]; then
    if [[ -f "$BACKUP_RUN_DIR/migration-journal.json" ]] \
      && journal_read_meta >/dev/null 2>&1; then
      # A failed forward step is evidence, not permission to mutate a second
      # time. Preserve the exact phase for a reviewed re-run or explicit
      # --rollback; automatic rollback could overwrite newly detected fstab or
      # backup drift and destroy the very evidence that caused the failure.
      write_backup_status interrupted "phase ${PHASE:-unknown} preserved after exit status ${status}; rerun --apply to resume or use explicit --rollback" || true
      printf 'runtime_layout_recovery=preserved_for_resume_or_explicit_rollback phase=%s\n' "${PHASE:-unknown}" >&2
    else
      printf 'runtime_layout_recovery=preserved_unreadable_journal\n' >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
step_backup_fstab() {
  local current_hash backup_hash
  assert_critical_effective_gate 'before-fstab-backup' guards
  if [[ -f "$FSTAB_BACKUP" && ! -L "$FSTAB_BACKUP" ]]; then
    current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
    [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] || fail 'fstab tamper detected before backup verification'
    backup_hash="$(sha256_file "$FSTAB_BACKUP")" || fail 'cannot hash fstab backup'
    [[ "$current_hash" == "$backup_hash" ]] || fail 'fstab backup content mismatch'
    FSTAB_BACKUP_HASH="$backup_hash"
    PHASE='fstab-backed-up'
    journal_write "$PHASE" || fail 'cannot publish fstab-backup journal phase'
    return 0
  fi
  current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
  [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] || fail 'fstab hash drifted before backup'
  cp --preserve=all -- "$FSTAB" "$FSTAB_BACKUP"
  cmp -s -- "$FSTAB" "$FSTAB_BACKUP" || fail 'fstab backup readback mismatch'
  FSTAB_BACKUP_HASH="$(sha256_file "$FSTAB_BACKUP")" || fail 'cannot hash fstab backup after copy'
  PHASE='fstab-backed-up'
  journal_write "$PHASE" || fail 'cannot publish fstab-backup journal phase'
}

step_state_data() {
  local dfp sfp state_delta
  assert_critical_effective_gate 'before-state-copy' guards
  if [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]]; then
    dfp="$(tree_fingerprint "$DATA_STATE")" || fail 'cannot fingerprint canonical state'
    [[ "$dfp" == "$STATE_SOURCE_FP" ]] || fail 'canonical state fingerprint mismatch'
    PHASE='state-data-created'
    journal_write "$PHASE" || fail 'cannot publish state-data journal phase'
    return 0
  fi
  if [[ -d "$STATE_STAGING" && ! -L "$STATE_STAGING" ]]; then
    sfp="$(tree_fingerprint "$STATE_STAGING")" || fail 'cannot fingerprint state staging tree'
    [[ "$sfp" == "$STATE_SOURCE_FP" ]] || fail 'state staging fingerprint mismatch'
    mv -- "$STATE_STAGING" "$DATA_STATE"
    dfp="$(tree_fingerprint "$DATA_STATE")" || fail 'cannot fingerprint canonical state after move'
    [[ "$dfp" == "$STATE_SOURCE_FP" ]] || fail 'canonical state fingerprint mismatch after move'
    PHASE='state-data-created'
    journal_write "$PHASE" || fail 'cannot publish state-data journal phase'
    return 0
  fi
  mkdir -- "$STATE_STAGING"
  chmod 0750 -- "$STATE_STAGING"
  chown --reference="$APP_STATE" -- "$STATE_STAGING"
  chmod --reference="$APP_STATE" -- "$STATE_STAGING"
  "$RSYNC_BIN" -aHAX --numeric-ids --one-file-system "$APP_STATE/" "$STATE_STAGING/"
  state_delta="$({ "$RSYNC_BIN" -aHAXnci --delete --numeric-ids --one-file-system "$APP_STATE/" "$STATE_STAGING/"; } 2>&1)" \
    || fail "state checksum dry-run failed: $state_delta"
  [[ -z "$state_delta" ]] || fail "state checksum dry-run is not empty: $state_delta"
  sfp="$(tree_fingerprint "$STATE_STAGING")" || fail 'cannot fingerprint state staging tree'
  [[ "$sfp" == "$STATE_SOURCE_FP" ]] || fail 'state staging fingerprint does not match source'
  assert_critical_effective_gate 'before-state-canonical-publish' guards
  mv -- "$STATE_STAGING" "$DATA_STATE"
  dfp="$(tree_fingerprint "$DATA_STATE")" || fail 'cannot fingerprint canonical state after move'
  [[ "$dfp" == "$STATE_SOURCE_FP" ]] || fail 'canonical state fingerprint mismatch after move'
  PHASE='state-data-created'
  journal_write "$PHASE" || fail 'cannot publish state-data journal phase'
}

step_outputs_unmount_prepare() {
  local fp bfp
  assert_critical_effective_gate 'before-outputs-unmount' guards
  if [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
    bfp="$(tree_fingerprint "$OUTPUTS_BACKUP")" || fail 'cannot fingerprint outputs underlay backup'
    if [[ -n "$OUTPUTS_SOURCE_FP" ]]; then
      [[ "$bfp" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay backup fingerprint mismatch'
    else
      OUTPUTS_SOURCE_FP="$bfp"
    fi
    PHASE='outputs-underlay-prepared'
    journal_write "$PHASE" || fail 'cannot publish outputs-underlay-prepared journal phase'
    return 0
  fi
  if is_mountpoint "$APP_OUTPUTS"; then
    "$UMOUNT_BIN" -- "$APP_OUTPUTS" || fail 'outputs host bind umount failed'
    ! is_mountpoint "$APP_OUTPUTS" || fail 'outputs host bind remained mounted after umount'
  fi
  assert_real_directory "$APP_OUTPUTS" 'revealed Git outputs underlay'
  fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'cannot fingerprint outputs underlay'
  if [[ -n "$OUTPUTS_SOURCE_FP" ]]; then
    [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay fingerprint mismatch'
  else
    OUTPUTS_SOURCE_FP="$fp"
  fi
  PHASE='outputs-underlay-prepared'
  journal_write "$PHASE" || fail 'cannot publish outputs-underlay-prepared journal phase'
}

reconstruct_tracked_outputs() {
  local index_list object_tmp restored_count=0 entry metadata relative mode object stage extra target restored_object
  "$GIT_BIN" -C "$ROOT" ls-files -z -- outputs >/dev/null 2>&1 || fail 'git index is unavailable'
  index_list="$(mktemp /tmp/shein-bi-runtime-output-index.XXXXXX)"
  "$GIT_BIN" -C "$ROOT" ls-files -s -z -- outputs >"$index_list" || { rm -f -- "$index_list"; fail 'cannot list tracked outputs index'; }
  while IFS= read -r -d '' entry; do
    [[ "$entry" == *$'\t'* ]] || fail 'invalid Git index record for outputs'
    metadata="${entry%%$'\t'*}"
    relative="${entry#*$'\t'}"
    read -r mode object stage extra <<<"$metadata"
    [[ -n "$mode" && "$object" =~ ^[a-f0-9]{40,64}$ && "$stage" == 0 && -z "${extra:-}" ]] \
      || fail "unsupported Git index metadata: $metadata"
    [[ "$mode" == 100644 || "$mode" == 100755 ]] || fail "tracked outputs must be regular files: $relative mode=$mode"
    [[ "$relative" == outputs/* && "$relative" != *'/../'* && "$relative" != '../'* ]] \
      || fail "unsafe tracked output path: $relative"
    target="$ROOT/$relative"
    [[ "$target" == "$APP_OUTPUTS/"* ]] || fail "tracked output escaped outputs root: $relative"
    mkdir -p -- "$(dirname -- "$target")"
    chmod 0755 -- "$(dirname -- "$target")"
    object_tmp="$target.runtime-layout-v2.$$"
    "$GIT_BIN" -C "$ROOT" cat-file blob "$object" >"$object_tmp" || fail "cannot extract tracked output: $relative"
    if [[ "$mode" == 100755 ]]; then chmod 0755 "$object_tmp"; else chmod 0644 "$object_tmp"; fi
    mv -- "$object_tmp" "$target" || fail "cannot publish tracked output: $relative"
    restored_object="$({ "$GIT_BIN" -C "$ROOT" hash-object -- "$target"; } 2>&1)" \
      || fail "cannot hash restored tracked output: $relative error=$restored_object"
    [[ "$restored_object" == "$object" ]] || fail "restored tracked output object mismatch: $relative"
    ((restored_count += 1))
  done <"$index_list"
  rm -f -- "$index_list"
  ((restored_count == tracked_count)) || fail "tracked outputs restore count mismatch expected=$tracked_count actual=$restored_count"
  assert_git_outputs_clean
}

step_outputs_move() {
  local fp bfp bfp2
  assert_critical_effective_gate 'before-outputs-underlay-move' guards
  if [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
    bfp="$(tree_fingerprint "$OUTPUTS_BACKUP")" || fail 'cannot fingerprint outputs underlay backup'
    [[ "$bfp" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay backup fingerprint mismatch'
  else
    if is_mountpoint "$APP_OUTPUTS"; then
      "$UMOUNT_BIN" -- "$APP_OUTPUTS" || fail 'outputs host bind umount failed'
    fi
    assert_real_directory "$APP_OUTPUTS" 'revealed Git outputs underlay'
    fp="$(tree_fingerprint "$APP_OUTPUTS")" || fail 'cannot fingerprint outputs underlay'
    [[ "$fp" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay fingerprint mismatch'
    assert_atomic_backup_device "$APP_OUTPUTS"
    mv -- "$APP_OUTPUTS" "$OUTPUTS_BACKUP"
    migration_failpoint 'after-outputs-move-before-recreate'
    bfp2="$(tree_fingerprint "$OUTPUTS_BACKUP")" || fail 'cannot fingerprint moved outputs underlay backup'
    [[ "$bfp2" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay backup fingerprint mismatch after move'
  fi
  if [[ ! -d "$APP_OUTPUTS" || -L "$APP_OUTPUTS" ]]; then
    mkdir -- "$APP_OUTPUTS"
    chmod 0755 -- "$APP_OUTPUTS"
  fi
  find "$APP_OUTPUTS" -xdev -type f -name '*.runtime-layout-v2.*' -delete 2>/dev/null || true
  reconstruct_tracked_outputs
  PHASE='outputs-underlay-moved'
  journal_write "$PHASE" || fail 'cannot publish outputs-underlay-moved journal phase'
}

step_state_move() {
  local fp bfp bfp2
  assert_critical_effective_gate 'before-state-underlay-move' guards
  if [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]]; then
    bfp="$(tree_fingerprint "$STATE_BACKUP")" || fail 'cannot fingerprint state underlay backup'
    [[ "$bfp" == "$STATE_SOURCE_FP" ]] || fail 'state underlay backup fingerprint mismatch'
    if [[ ! -d "$APP_STATE" || -L "$APP_STATE" ]]; then
      mkdir -- "$APP_STATE"
      chmod 0750 -- "$APP_STATE"
    fi
    PHASE='state-underlay-moved'
    journal_write "$PHASE" || fail 'cannot publish state-underlay-moved journal phase'
    return 0
  fi
  fp="$(tree_fingerprint "$APP_STATE")" || fail 'cannot fingerprint application state underlay'
  [[ "$fp" == "$STATE_SOURCE_FP" ]] || fail 'application state underlay fingerprint mismatch'
  assert_atomic_backup_device "$APP_STATE"
  mv -- "$APP_STATE" "$STATE_BACKUP"
  migration_failpoint 'after-state-move-before-recreate'
  bfp2="$(tree_fingerprint "$STATE_BACKUP")" || fail 'cannot fingerprint moved state underlay backup'
  [[ "$bfp2" == "$STATE_SOURCE_FP" ]] || fail 'state underlay backup fingerprint mismatch after move'
  mkdir -- "$APP_STATE"
  chmod 0750 -- "$APP_STATE"
  chown --reference="$DATA_STATE" -- "$APP_STATE"
  chmod --reference="$DATA_STATE" -- "$APP_STATE"
  PHASE='state-underlay-moved'
  journal_write "$PHASE" || fail 'cannot publish state-underlay-moved journal phase'
}

step_readonly_mounts() {
  assert_critical_effective_gate 'before-readonly-remounts' guards
  if ! is_mountpoint "$APP_STATE"; then
    # The v2 fstab entry is intentionally published only after both read-only
    # mounts are live and verified. Mount the new canonical state explicitly;
    # a target-only `mount $APP_STATE` cannot work while fstab is still legacy.
    "$MOUNT_BIN" --bind -- "$DATA_STATE" "$APP_STATE" || fail 'state bind mount failed'
  fi
  "$MOUNT_BIN" -o remount,bind,ro -- "$APP_STATE" || fail 'state read-only remount failed'
  "$MOUNT_BIN" -o remount,bind,ro -- "$APP_PROFILES" || fail 'profiles read-only remount failed'
  assert_read_only_mount "$APP_STATE"
  assert_read_only_mount "$APP_PROFILES"
  PHASE='readonly-mounts-done'
  journal_write "$PHASE" || fail 'cannot publish readonly-mounts journal phase'
}

step_fstab_prepare() {
  local current_hash stage_hash
  assert_critical_effective_gate 'before-fstab-prepare' all
  if [[ "$(render_fstab mode)" == v2 ]]; then
    [[ -n "$EXPECTED_FSTAB_V2_HASH" ]] || fail 'v2 fstab detected without a recorded expected content'
    [[ "$(sha256_file "$FSTAB")" == "$EXPECTED_FSTAB_V2_HASH" ]] \
      || fail 'current v2 fstab content does not match the recorded transform'
    PHASE='fstab-publish-prepared'
    journal_write "$PHASE" || fail 'cannot publish fstab-publish-prepared journal phase'
    return 0
  fi
  [[ "$(read_maintenance_gate)" == "$maintenance_generation" ]] || fail 'maintenance marker generation drifted'
  [[ "$(maintenance_guard_audit)" == "$maintenance_policy_count" ]] || fail 'maintenance guard installer audit drifted'
  [[ "$(namespace_audit)" == "$policy_count" ]] || fail 'namespace installer audit drifted'
  assert_all_services_inactive >/dev/null
  assert_no_chrome
  current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
  [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] || fail 'fstab drifted before v2 publish'
  if [[ -n "$FSTAB_STAGE_PATH" && -f "$FSTAB_STAGE_PATH" && ! -L "$FSTAB_STAGE_PATH" ]]; then
    stage_hash="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'cannot hash staged v2 fstab'
    if [[ -n "$EXPECTED_FSTAB_V2_HASH" ]]; then
      [[ "$stage_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] || fail 'staged v2 fstab hash mismatch'
    else
      EXPECTED_FSTAB_V2_HASH="$stage_hash"
    fi
  else
    FSTAB_STAGE_PATH="$(mktemp "$(dirname -- "$FSTAB")/.fstab.runtime-layout-v2.XXXXXX")"
    cp --preserve=all -- "$FSTAB" "$FSTAB_STAGE_PATH"
    render_fstab content >"$FSTAB_STAGE_PATH" || { rm -f -- "$FSTAB_STAGE_PATH"; FSTAB_STAGE_PATH=''; fail 'cannot render staged v2 fstab'; }
    EXPECTED_FSTAB_V2_HASH="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'cannot hash staged v2 fstab'
  fi
  [[ "$(render_fstab mode "$FSTAB_STAGE_PATH")" == v2 ]] || fail 'staged v2 fstab layout validation failed'
  assert_same_file_owner_mode "$FSTAB" "$FSTAB_STAGE_PATH" 'staged v2 fstab'
  sync -f -- "$FSTAB_STAGE_PATH" || fail 'cannot fsync staged v2 fstab'
  sync -f -- "$(dirname -- "$FSTAB")" || fail 'cannot fsync fstab directory after staging'
  PHASE='fstab-publish-prepared'
  journal_write "$PHASE" || fail 'cannot publish fstab-publish-prepared journal phase'
}

step_fstab_publish() {
  local current_hash stage_hash
  assert_critical_effective_gate 'before-fstab-publish' all
  current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
  if [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]]; then
    if [[ -z "$FSTAB_STAGE_PATH" || ! -f "$FSTAB_STAGE_PATH" || -L "$FSTAB_STAGE_PATH" ]]; then
      FSTAB_STAGE_PATH="$(mktemp "$(dirname -- "$FSTAB")/.fstab.runtime-layout-v2.XXXXXX")"
      cp --preserve=all -- "$FSTAB" "$FSTAB_STAGE_PATH"
      render_fstab content >"$FSTAB_STAGE_PATH" || { rm -f -- "$FSTAB_STAGE_PATH"; FSTAB_STAGE_PATH=''; fail 'cannot render v2 fstab for publish'; }
      EXPECTED_FSTAB_V2_HASH="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'cannot hash v2 fstab for publish'
      sync -f -- "$FSTAB_STAGE_PATH" || fail 'cannot fsync v2 fstab stage before publish'
      PHASE='fstab-publish-prepared'
      journal_write "$PHASE" || fail 'cannot publish fstab-publish-prepared journal phase'
    fi
    stage_hash="$(sha256_file "$FSTAB_STAGE_PATH")" || fail 'cannot hash staged v2 fstab'
    [[ "$stage_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] || fail 'staged v2 fstab hash mismatch at publish'
    [[ "$(render_fstab mode "$FSTAB_STAGE_PATH")" == v2 ]] || fail 'staged v2 fstab layout validation failed'
    assert_same_file_owner_mode "$FSTAB" "$FSTAB_STAGE_PATH" 'staged v2 fstab at publish'
    sync -f -- "$FSTAB_STAGE_PATH" || fail 'cannot fsync staged v2 fstab immediately before publish'
    assert_critical_effective_gate 'before-fstab-atomic-rename' all
    migration_failpoint 'before-fstab-atomic-rename'
    mv -- "$FSTAB_STAGE_PATH" "$FSTAB"
    sync -f -- "$FSTAB" || fail 'cannot fsync published v2 fstab'
    sync -f -- "$(dirname -- "$FSTAB")" || fail 'cannot fsync fstab directory after publish'
    migration_failpoint 'after-fstab-publish-before-journal'
    FSTAB_STAGE_PATH=''
  elif [[ "$current_hash" == "$EXPECTED_FSTAB_V2_HASH" ]]; then
    # Publish was already durable before the phase update (for example, a
    # power loss immediately after rename). The consumed stage path must not
    # survive in later journal phases.
    FSTAB_STAGE_PATH=''
  else
    fail 'current fstab matches neither source nor expected v2 content'
  fi
  [[ "$(render_fstab mode)" == v2 ]] || fail 'fstab v2 publish readback failed'
  [[ "$(sha256_file "$FSTAB")" == "$EXPECTED_FSTAB_V2_HASH" ]] || fail 'published v2 fstab content hash mismatch'
  "$SYSTEMCTL_BIN" daemon-reload || fail 'systemctl daemon-reload failed after fstab publish'
  PHASE='fstab-published'
  journal_write "$PHASE" || fail 'cannot publish fstab-published journal phase'
}

step_verify() {
  local state_delta
  [[ "$(render_fstab mode)" == v2 ]] || fail 'final fstab layout is not v2'
  assert_read_only_mount "$APP_PROFILES"
  assert_read_only_mount "$APP_STATE"
  ! is_mountpoint "$APP_OUTPUTS" || fail 'tracked outputs must not be a host mountpoint'
  assert_git_outputs_clean
  [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]] || fail 'state underlay backup is missing or unsafe'
  [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]] || fail 'outputs underlay backup is missing or unsafe'
  [[ "$(tree_fingerprint "$STATE_BACKUP")" == "$STATE_SOURCE_FP" ]] || fail 'state underlay backup fingerprint mismatch'
  [[ "$(tree_fingerprint "$OUTPUTS_BACKUP")" == "$OUTPUTS_SOURCE_FP" ]] || fail 'outputs underlay backup fingerprint mismatch'
  [[ "$(sha256_file "$FSTAB_BACKUP")" == "$FSTAB_SOURCE_HASH" ]] || fail 'retained fstab backup hash mismatch'
  state_delta="$({ "$RSYNC_BIN" -aHAXnci --delete --numeric-ids --one-file-system "$STATE_BACKUP/" "$DATA_STATE/"; } 2>&1)" \
    || fail "retained state backup verification failed: $state_delta"
  [[ -z "$state_delta" ]] || fail "retained state backup differs from canonical state: $state_delta"
  if ((!FIXTURE)); then
    [[ "$(stat -Lc '%d:%i' "$DATA_PROFILES")" == "$(stat -Lc '%d:%i' "$APP_PROFILES")" ]] \
      || fail 'final profiles mount source mismatch'
    [[ "$(stat -Lc '%d:%i' "$DATA_STATE")" == "$(stat -Lc '%d:%i' "$APP_STATE")" ]] \
      || fail 'final state mount source mismatch'
    [[ "$(stat -Lc '%d:%i' "$DATA_OUTPUTS")" != "$(stat -Lc '%d:%i' "$APP_OUTPUTS")" ]] \
      || fail 'final outputs path still resolves to runtime outputs'
  fi
  [[ "$(namespace_audit)" == "$policy_count" ]] || fail 'final namespace audit drifted'
  [[ "$(maintenance_guard_audit)" == "$maintenance_policy_count" ]] || fail 'final maintenance guard audit drifted'
  assert_generated_mount_contract
  assert_no_source_tree_backups
  assert_critical_effective_gate 'before-verified-journal' all
  PHASE='verified'
  journal_write "$PHASE" || fail 'cannot publish migration completion journal phase'
  write_backup_status complete 'v2 layout verified; source underlay backups retained outside the application tree' \
    || fail 'cannot publish migration completion status'
}

advance_step() {
  case "$PHASE" in
    init) step_backup_fstab ;;
    fstab-backed-up) step_state_data ;;
    state-data-created) step_outputs_unmount_prepare ;;
    outputs-underlay-prepared) step_outputs_move ;;
    outputs-underlay-moved) step_state_move ;;
    state-underlay-moved) step_readonly_mounts ;;
    readonly-mounts-done) step_fstab_prepare ;;
    fstab-publish-prepared) step_fstab_publish ;;
    fstab-published) step_verify ;;
    verified|rolled-back) return 0 ;;
    *) fail "unsupported journal phase: $PHASE" ;;
  esac
}

migrate_loop() {
  local limit="${SHEIN_BI_MIGRATION_STAGE_LIMIT:-0}"
  while :; do
    advance_step
    if [[ "$PHASE" == verified || "$PHASE" == rolled-back ]]; then return 0; fi
    if ((limit > 0)); then
      ((STAGE_COUNT += 1))
      if ((STAGE_COUNT >= limit)); then
        printf 'runtime_layout_failpoint=stage_limit_%d_reached_phase=%s\n' "$STAGE_COUNT" "$PHASE" >&2
        kill -9 $$
      fi
    fi
  done
}

load_journal_globals() {
  local mode="${1:-forward}"
  local meta current_fstab_hash
  meta="$(journal_read_meta)" || fail 'migration journal is unreadable or tampered'
  IFS=$'\t' read -r J_PHASE_OUT J_SRC_HASH J_BK_HASH J_STATE_FP J_OUT_FP J_EXPECTED J_STAGE <<<"$meta"
  PHASE="$J_PHASE_OUT"
  FSTAB_SOURCE_HASH="$J_SRC_HASH"
  FSTAB_BACKUP_HASH="$J_BK_HASH"
  STATE_SOURCE_FP="$J_STATE_FP"
  OUTPUTS_SOURCE_FP="$J_OUT_FP"
  EXPECTED_FSTAB_V2_HASH="$J_EXPECTED"
  FSTAB_STAGE_PATH="$J_STAGE"
  FSTAB_BACKUP="$BACKUP_RUN_DIR/fstab"
  STATE_BACKUP="$BACKUP_RUN_DIR/state-underlay"
  OUTPUTS_BACKUP="$BACKUP_RUN_DIR/outputs-git-underlay"
  STATE_STAGING="$DATA_ROOT/.state-runtime-layout-v2-$STAMP.staging"
  [[ -d "$BACKUP_RUN_DIR" && ! -L "$BACKUP_RUN_DIR" ]] || fail 'migration journal run directory is missing'
  current_fstab_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab while loading migration journal'
  if [[ "$mode" == rollback ]]; then
    # An explicit rollback is authorized by its own marker; the fstab bytes may
    # legitimately be either the still-published v2 content or the restored
    # legacy source while rollback is mid-flight. Any other value is drift.
    if [[ -n "$EXPECTED_FSTAB_V2_HASH" ]]; then
      [[ "$current_fstab_hash" == "$FSTAB_SOURCE_HASH" || "$current_fstab_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
        || fail 'fstab drifted beyond the rollback journal evidence'
    else
      [[ "$current_fstab_hash" == "$FSTAB_SOURCE_HASH" ]] \
        || fail 'fstab drifted beyond the rollback journal evidence'
    fi
  elif [[ "$PHASE" == fstab-published || "$PHASE" == verified ]]; then
    [[ -n "$EXPECTED_FSTAB_V2_HASH" && "$current_fstab_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
      || fail 'published fstab drifted from the migration journal'
  elif [[ "$current_fstab_hash" != "$FSTAB_SOURCE_HASH" ]]; then
    # The sole allowed pre-published exception is a crash after atomic fstab
    # rename but before the phase journal update.
    [[ -n "$EXPECTED_FSTAB_V2_HASH" && "$current_fstab_hash" == "$EXPECTED_FSTAB_V2_HASH" ]] \
      || fail 'fstab drifted before v2 publish'
  fi
  # fstab layout is not a hard precondition here: steps re-derive it from the
  # recorded hashes, so an already-published v2 fstab (legacy crash adoption)
  # can be resumed without regressing the phase machine.
  if [[ "$mode" != rollback && ( "$PHASE" == fstab-published || "$PHASE" == verified ) ]]; then
    [[ "$fstab_layout" == v2 ]] || fail "journal phase ${PHASE} requires the v2 fstab layout"
  fi
}

load_v1_globals() {
  local status_schema status_stamp
  STAMP="$(basename -- "$BACKUP_RUN_DIR")"
  FSTAB_BACKUP="$BACKUP_RUN_DIR/fstab"
  STATE_BACKUP="$BACKUP_RUN_DIR/state-underlay"
  OUTPUTS_BACKUP="$BACKUP_RUN_DIR/outputs-git-underlay"
  STATE_STAGING="$DATA_ROOT/.state-runtime-layout-v2-$STAMP.staging"
  FSTAB_STAGE_PATH=''
  EXPECTED_FSTAB_V2_HASH=''
  OUTPUTS_SOURCE_FP=''
  [[ -f "$BACKUP_RUN_DIR/migration-status.json" && ! -L "$BACKUP_RUN_DIR/migration-status.json" ]] \
    || fail 'legacy migration status record is missing or unsafe'
  status_schema="$(read_status_field "$BACKUP_RUN_DIR/migration-status.json" schemaVersion)" \
    || fail 'legacy migration status schema is unreadable'
  status_stamp="$(read_status_field "$BACKUP_RUN_DIR/migration-status.json" stamp)" \
    || fail 'legacy migration status stamp is unreadable'
  [[ "$status_schema" == cloud-runtime-layout-migration-status/v1 ]] \
    || fail 'legacy migration status schema is unsupported'
  [[ "$status_stamp" == "$STAMP" && "$STAMP" =~ ^[A-Za-z0-9._-]{1,128}$ ]] \
    || fail 'legacy migration status stamp does not bind its backup directory'
  [[ -f "$FSTAB_BACKUP" && ! -L "$FSTAB_BACKUP" ]] || fail 'legacy migration record lacks an exact fstab backup'
  [[ "$(render_fstab mode "$FSTAB_BACKUP")" == legacy ]] || fail 'legacy fstab backup does not describe the exact legacy layout'
  FSTAB_SOURCE_HASH="$(sha256_file "$FSTAB_BACKUP")" || fail 'cannot hash legacy fstab backup'
  FSTAB_BACKUP_HASH="$FSTAB_SOURCE_HASH"
  if [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]]; then
    STATE_SOURCE_FP="$(tree_fingerprint "$STATE_BACKUP")" || fail 'cannot fingerprint legacy state underlay backup'
  else
    STATE_SOURCE_FP="$(tree_fingerprint "$APP_STATE")" || fail 'cannot fingerprint application state underlay'
  fi
  if [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
    OUTPUTS_SOURCE_FP="$(tree_fingerprint "$OUTPUTS_BACKUP")" \
      || fail 'cannot fingerprint legacy outputs underlay backup'
  elif ! is_mountpoint "$APP_OUTPUTS" && [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]]; then
    OUTPUTS_SOURCE_FP="$(tree_fingerprint "$APP_OUTPUTS")" \
      || fail 'cannot fingerprint revealed legacy outputs underlay'
  fi
}

adopt_v1() {
  local status_value
  status_value="$(read_status_field "$BACKUP_RUN_DIR/migration-status.json" status)" \
    || fail 'legacy migration status record is unreadable'
  [[ "$status_value" != complete && "$status_value" != rolled_back ]] \
    || fail "legacy migration record is already terminal: ${status_value}"
  load_v1_globals
  if [[ -d "$STATE_BACKUP" && ! -L "$STATE_BACKUP" ]]; then
    PHASE='state-underlay-moved'
  elif [[ -d "$OUTPUTS_BACKUP" && ! -L "$OUTPUTS_BACKUP" ]]; then
    PHASE='outputs-underlay-moved'
  elif is_mountpoint "$APP_OUTPUTS"; then
    PHASE='state-data-created'
  elif [[ -d "$APP_OUTPUTS" && ! -L "$APP_OUTPUTS" ]]; then
    PHASE='outputs-underlay-prepared'
  elif [[ -d "$DATA_STATE" && ! -L "$DATA_STATE" ]]; then
    PHASE='state-data-created'
  else
    PHASE='fstab-backed-up'
  fi
  if [[ "$fstab_layout" == v2 ]]; then
    local current_hash expected_hash staged
    current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
    staged="$(mktemp "$(dirname -- "$FSTAB")/.fstab.runtime-layout-v2.XXXXXX")"
    cp --preserve=all -- "$FSTAB_BACKUP" "$staged"
    render_fstab content >"$staged" || { rm -f -- "$staged"; fail 'cannot render expected v2 fstab from legacy backup'; }
    expected_hash="$(sha256_file "$staged")" || { rm -f -- "$staged"; fail 'cannot hash expected v2 fstab'; }
    rm -f -- "$staged"
    [[ "$current_hash" == "$expected_hash" ]] \
      || fail 'current v2 fstab content does not match the legacy backup transform'
    EXPECTED_FSTAB_V2_HASH="$expected_hash"
  else
    local current_hash
    current_hash="$(sha256_file "$FSTAB")" || fail 'cannot hash current fstab'
    [[ "$current_hash" == "$FSTAB_SOURCE_HASH" ]] || fail 'current legacy fstab content drifted from the record backup'
  fi
  assert_critical_effective_gate 'before-v1-adoption-journal' guards
  write_backup_status resumed 'legacy migration record adopted as an active journal'
  journal_write "$PHASE" || fail 'cannot reconstitute a migration journal from the legacy record'
  ACTION_LABEL="adopted-legacy:${PHASE}"
  migrate_loop
}

run_resume() {
  if [[ -f "$BACKUP_RUN_DIR/migration-rollback.json" && ! -L "$BACKUP_RUN_DIR/migration-rollback.json" ]]; then
    fail 'forward resume is blocked while an explicit rollback is in progress; use --rollback to continue it'
  fi
  load_journal_globals
  ACTION_LABEL="resumed:${PHASE}"
  assert_critical_effective_gate 'before-resume-status' guards
  write_backup_status resumed "journal phase ${PHASE}"
  migrate_loop
}

apply_run_init() {
  local root_device reserved_path
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  BACKUP_RUN_DIR="$BACKUP_ROOT/$STAMP"
  FSTAB_BACKUP="$BACKUP_RUN_DIR/fstab"
  STATE_BACKUP="$BACKUP_RUN_DIR/state-underlay"
  OUTPUTS_BACKUP="$BACKUP_RUN_DIR/outputs-git-underlay"
  STATE_STAGING="$DATA_ROOT/.state-runtime-layout-v2-$STAMP.staging"
  FSTAB_STAGE_PATH=''
  EXPECTED_FSTAB_V2_HASH=''
  OUTPUTS_SOURCE_FP=''
  FSTAB_BACKUP_HASH=''
  for reserved_path in "$BACKUP_RUN_DIR" "$STATE_STAGING"; do
    [[ ! -e "$reserved_path" && ! -L "$reserved_path" ]] \
      || fail "reserved migration path already exists: $reserved_path"
  done
  assert_backup_root_device_compatible
  root_device="$(stat -Lc '%d' -- "$ROOT")" || fail 'cannot read application root device'
  assert_critical_effective_gate 'before-migration-journal-init' guards
  if [[ ! -e "$BACKUP_ROOT" ]]; then
    mkdir -p -- "$BACKUP_ROOT"
    chmod 0700 -- "$BACKUP_ROOT"
  fi
  assert_real_directory "$BACKUP_ROOT" 'layout migration backup root'
  [[ "$(stat -Lc '%d' -- "$BACKUP_ROOT")" == "$root_device" ]] \
    || fail 'created backup root device changed after preflight'
  mkdir -p -- "$BACKUP_RUN_DIR"
  chmod 0700 -- "$BACKUP_RUN_DIR"
  assert_atomic_backup_device "$APP_STATE"
  write_backup_status started 'preflight passed; no app underlay has been moved yet'
  FSTAB_SOURCE_HASH="$FSTAB_ORIGINAL_HASH"
  STATE_SOURCE_FP="$(tree_fingerprint "$APP_STATE")" || fail 'cannot fingerprint application state underlay'
  PHASE='init'
  journal_write "$PHASE" || fail 'cannot publish migration journal start record'
  ACTION_LABEL='fresh'
  migrate_loop
}
discover_journal() {
  local -a candidates=() legacy_dirs=() active_v1=()
  local file active='' phase d status verified_file=''
  RESOLVED_ACTION='fresh'
  if [[ -d "$BACKUP_ROOT" ]]; then
    shopt -s nullglob
    candidates=( "$BACKUP_ROOT"/*/migration-journal.json )
    shopt -u nullglob
    for file in "${candidates[@]}"; do
      phase="$(read_journal_phase "$file" 2>/dev/null || true)"
      if [[ "$phase" == verified ]]; then verified_file="$file"; continue; fi
      if [[ "$phase" == rolled-back ]]; then continue; fi
      if [[ -z "$active" ]]; then active="$file"; else fail 'multiple active migration journals found'; fi
    done
    if [[ -n "$active" ]]; then
      BACKUP_RUN_DIR="$(dirname -- "$active")"
      STAMP="$(basename -- "$BACKUP_RUN_DIR")"
      RESOLVED_ACTION='resume'
      return 0
    fi
    if [[ "$fstab_layout" == v2 && -n "$verified_file" ]]; then
      BACKUP_RUN_DIR="$(dirname -- "$verified_file")"
      STAMP="$(basename -- "$BACKUP_RUN_DIR")"
      RESOLVED_ACTION='complete'
      return 0
    fi
    for d in "$BACKUP_ROOT"/*/; do
      if [[ -f "${d%/}/migration-status.json" && ! -e "${d%/}/migration-journal.json" ]]; then
        legacy_dirs+=("${d%/}")
      fi
    done
    for d in "${legacy_dirs[@]}"; do
      status="$(read_status_field "$d/migration-status.json" status 2>/dev/null || true)"
      if [[ "$status" != complete && "$status" != rolled_back && "$status" != rollback_failed ]]; then
        active_v1+=("$d")
      fi
    done
    if (( ${#active_v1[@]} == 1 )); then
      BACKUP_RUN_DIR="${active_v1[0]}"
      STAMP="$(basename -- "$BACKUP_RUN_DIR")"
      RESOLVED_ACTION='adopt-v1'
    elif (( ${#active_v1[@]} > 1 )); then
      RESOLVED_ACTION='none-v2-active'
    fi
  fi
  if [[ "$RESOLVED_ACTION" == fresh && "$fstab_layout" == v2 ]]; then
    RESOLVED_ACTION='none-v2-orphan'
  fi
}

apply_rollback() {
  case "$RESOLVED_ACTION" in
    fresh)
      if [[ "$fstab_layout" == v2 ]]; then
        fail 'no active migration journal; refusing blind rollback from v2'
      fi
      fail 'nothing to roll back: no active migration record'
      ;;
    complete)
      fail 'migration is already complete; nothing to roll back'
      ;;
    none-v2-orphan)
      fail 'no active migration journal; refusing blind rollback from v2'
      ;;
    none-v2-active)
      fail 'multiple legacy migration records found; manual review required'
      ;;
    resume)
      if [[ -f "$BACKUP_RUN_DIR/migration-rollback.json" && ! -L "$BACKUP_RUN_DIR/migration-rollback.json" ]]; then
        ROLLBACK_RESUMING=1
        load_journal_globals rollback
      else
        ROLLBACK_RESUMING=0
        load_journal_globals
      fi
      ;;
    adopt-v1)
      fail 'explicit rollback requires a v2 journal phase; legacy v1 evidence must be reviewed and adopted forward first'
      ;;
  esac
  restore_legacy
  if ((!RESTORE_OK)); then
    write_backup_status rollback_failed 'rollback could not fully restore fstab and mount topology' || true
    fail 'rollback failed; manual intervention required'
  fi
  migration_failpoint 'before-rollback-terminal-journal'
  PHASE='rolled-back'
  journal_write "$PHASE" || fail 'cannot publish rollback journal phase'
  write_backup_status rolled_back 'fstab and original mount topology restored; backup directory retained for audit'
  COMPLETED=1
  printf '{"ok":true,"mode":"rollback","layout":"legacy","recovery":"%s","backupRoot":"%s","backupRunDir":"%s","fstabBackup":"%s","stateBackup":"%s","outputsUnderlayBackup":"%s","hostProfiles":"rw","hostState":"unmounted","hostOutputsMounted":true,"fingerprintTar":"%s"}\n' \
    "$ACTION_LABEL" "$BACKUP_ROOT" "$BACKUP_RUN_DIR" "$FSTAB_BACKUP" "$STATE_BACKUP" "$OUTPUTS_BACKUP" "$FINGERPRINT_TAR_VERSION"
}

apply_migrate() {
  case "$RESOLVED_ACTION" in
    fresh) apply_run_init ;;
    resume) run_resume ;;
    adopt-v1) adopt_v1 ;;
    complete)
      COMPLETED=1
      printf '{"ok":true,"mode":"apply","layout":"v2","recovery":"already-complete","maintenancePolicyCount":%s,"policyCount":%s,"serviceCount":%s,"trackedOutputCount":%s,"backupRoot":"%s","confirmation":"%s","fingerprintTar":"%s"}\n' \
        "$maintenance_policy_count" "$policy_count" "$service_count" "$tracked_count" "$BACKUP_ROOT" "$CONFIRMATION" "$FINGERPRINT_TAR_VERSION"
      exit 0
      ;;
    none-v2-orphan) fail 'v2 layout has no migration journal; manual review required' ;;
    none-v2-active) fail 'multiple legacy migration records found; manual review required' ;;
  esac
  if [[ "$PHASE" != verified ]]; then
    fail "migration did not reach the verified terminal phase: ${PHASE}"
  fi
  COMPLETED=1
  printf '{"ok":true,"mode":"apply","layout":"v2","recovery":"%s","maintenancePolicyCount":%s,"policyCount":%s,"serviceCount":%s,"trackedOutputCount":%s,"backupRoot":"%s","backupRunDir":"%s","fstabBackup":"%s","stateBackup":"%s","outputsUnderlayBackup":"%s","hostProfiles":"ro","hostState":"ro","hostOutputsMounted":false,"generatedMountContract":true,"fingerprintTar":"%s"}\n' \
    "$ACTION_LABEL" "$maintenance_policy_count" "$policy_count" "$service_count" "$tracked_count" \
    "$BACKUP_ROOT" "$BACKUP_RUN_DIR" "$FSTAB_BACKUP" "$STATE_BACKUP" "$OUTPUTS_BACKUP" "$FINGERPRINT_TAR_VERSION"
}

assert_real_directory "$ROOT" 'application root'
assert_real_directory "$DATA_ROOT" 'data root'
assert_real_directory "$SYSTEMD_DIR" 'systemd directory'
assert_regular_file "$FSTAB" 'fstab'
assert_regular_file "$MAINTENANCE_MARKER" 'maintenance marker'
assert_regular_file "$NAMESPACE_INSTALLER" 'namespace installer'
assert_regular_file "$MAINTENANCE_INSTALLER" 'maintenance guard installer'
assert_regular_file "$RUNTIME_INVENTORY_MODULE" 'cloud runtime inventory module'
assert_regular_file "$RUNTIME_PATH_POLICY_MODULE" 'cloud runtime path policy module'
assert_regular_file "$RUNTIME_SNAPSHOT_MODULE" 'cloud runtime snapshot module'
assert_regular_file "$SYSTEMD_SNAPSHOT_MODULE" 'systemd snapshot module'
assert_backup_root_path
assert_no_source_tree_backups
for command in "$SYSTEMCTL_BIN" "$FINDMNT_BIN" "$MOUNTPOINT_BIN" "$MOUNT_BIN" "$UMOUNT_BIN" "$PGREP_BIN" "$RSYNC_BIN" "$GIT_BIN" "$SYSTEMD_ESCAPE_BIN" "$TAR_BIN" mktemp touch node realpath sha256sum readlink stat find sort awk sync; do
  command_available "$command" || fail "required command is unavailable: $command"
done
FINGERPRINT_READY=1
fingerprint_capability || fail 'deterministic GNU tar fingerprint capability is unavailable'
assert_real_directory "$APP_PROFILES" 'application profiles path'
assert_real_directory "$DATA_PROFILES" 'canonical profiles path'
assert_real_directory "$DATA_OUTPUTS" 'canonical outputs path'
assert_real_data_mount
assert_backup_root_device_compatible
maintenance_generation="$(read_maintenance_gate)" || fail 'maintenance marker validation failed'
maintenance_policy_count="$(maintenance_guard_audit)" || fail 'maintenance guard audit validation failed'
policy_count="$(namespace_audit)" || fail 'namespace audit validation failed'
assert_all_services_inactive >/dev/null || fail 'inactive-service gate failed'
service_count="${#installed_services[@]}"
assert_no_chrome
assert_effective_systemd_controls all 'initial-migration-preflight'
fstab_layout="$(render_fstab mode)" || fail 'fstab layout validation failed'
FSTAB_ORIGINAL_HASH="$(sha256sum -- "$FSTAB" | awk '{print $1}')" || fail 'cannot hash source fstab'
tracked_count="$(tracked_output_count)" || fail 'cannot enumerate tracked outputs'
((tracked_count > 0)) || fail 'Git index contains no tracked outputs'

discover_journal
case "$RESOLVED_ACTION" in
  none-v2-orphan) fail 'v2 layout has no migration journal; manual review required' ;;
  none-v2-active) fail 'multiple legacy migration records found; manual review required' ;;
esac
case "$RESOLVED_ACTION" in
  fresh|complete)
    assert_real_directory "$APP_STATE" 'application state path'
    assert_real_directory "$APP_OUTPUTS" 'application outputs path'
    run_layout_topological_asserts
    ;;
  resume|adopt-v1)
    # A real crash can occur after an atomic underlay move but before the
    # replacement mountpoint directory is recreated. Permit only absence or a
    # canonical real directory here; the phase step reconstructs the missing
    # path before any mount/publish operation.
    assert_optional_real_directory "$APP_STATE" 'recoverable application state path'
    assert_optional_real_directory "$APP_OUTPUTS" 'recoverable application outputs path'
    ;;
esac

if [[ "$RESOLVED_ACTION" == complete ]]; then
  load_journal_globals
  [[ "$PHASE" == verified ]] || fail 'completed migration journal is not verified'
fi

if ((!APPLY && !ROLLBACK_FLAG)) && [[ "$RESOLVED_ACTION" == resume ]]; then
  if [[ -f "$BACKUP_RUN_DIR/migration-rollback.json" && ! -L "$BACKUP_RUN_DIR/migration-rollback.json" ]]; then
    ROLLBACK_PHASE="$(rollback_marker_read_phase)" || fail 'rollback marker is unreadable or tampered'
    load_journal_globals rollback
  else
    load_journal_globals
  fi
fi

if ((!APPLY && !ROLLBACK_FLAG)); then
  if [[ "$RESOLVED_ACTION" == fresh ]]; then
    printf '{"ok":true,"mode":"audit","layout":"%s","maintenanceMode":"all","maintenanceGeneration":%s,"maintenancePolicyCount":%s,"policyCount":%s,"serviceCount":%s,"trackedOutputCount":%s,"backupRoot":"%s","confirmation":"%s","fingerprintTar":"%s"}\n' \
      "$fstab_layout" "$maintenance_generation" "$maintenance_policy_count" "$policy_count" "$service_count" "$tracked_count" "$BACKUP_ROOT" "$CONFIRMATION" "$FINGERPRINT_TAR_VERSION"
  else
    printf '{"ok":true,"mode":"audit","layout":"%s","recovery":{"action":"%s","phase":"%s","stamp":"%s"},"maintenanceMode":"all","maintenanceGeneration":%s,"maintenancePolicyCount":%s,"policyCount":%s,"serviceCount":%s,"trackedOutputCount":%s,"backupRoot":"%s","confirmation":"%s","fingerprintTar":"%s"}\n' \
      "$fstab_layout" "$RESOLVED_ACTION" "${PHASE:-unknown}" "${STAMP:-}" "$maintenance_generation" "$maintenance_policy_count" "$policy_count" "$service_count" "$tracked_count" "$BACKUP_ROOT" "$CONFIRMATION" "$FINGERPRINT_TAR_VERSION"
  fi
  exit 0
fi

if [[ "$RESOLVED_ACTION" == fresh ]]; then
  [[ "$fstab_layout" == legacy ]] || fail 'apply is allowed only from the exact legacy layout'
fi

if ((ROLLBACK_FLAG)); then
  assert_critical_effective_gate 'before-rollback-dispatch' guards
  apply_rollback
  exit 0
fi
assert_critical_effective_gate 'before-apply-dispatch' guards
apply_migrate
