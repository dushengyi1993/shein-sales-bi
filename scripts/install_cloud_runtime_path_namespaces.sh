#!/usr/bin/env bash
set -Eeuo pipefail

umask 022

readonly CONFIRMATION='INSTALL_CLOUD_RUNTIME_PATH_NAMESPACES'
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
SYSTEMD_DIR="${SHEIN_BI_SYSTEMD_DIR:-/etc/systemd/system}"
SYSTEMCTL_BIN="${SHEIN_BI_SYSTEMCTL_BIN:-systemctl}"
RUNTIME_ROOT="${SHEIN_BI_RUNTIME_ROOT:-/srv/shein-bi/runtime}"
RUNTIME_USER="${SHEIN_BI_RUNTIME_USER:-sheinops}"
RUNTIME_GROUP="${SHEIN_BI_RUNTIME_GROUP:-sheinops}"
APPLY=0
CONFIRM=''
seen_root=0
seen_systemd_dir=0
seen_apply=0
seen_confirm=0

usage() {
  printf '%s\n' "Usage: $0 [--root <absolute-repository-root>] [--systemd-dir <absolute-directory>] [--apply --confirm $CONFIRMATION]" >&2
}

usage_error() {
  printf 'configuration_error=%s\n' "$1" >&2
  usage
  exit 64
}

fail() {
  printf 'runtime_path_namespace_install_error=%s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --root)
      ((seen_root == 0)) || usage_error 'duplicate --root'
      (($# >= 2)) || usage_error 'missing value for --root'
      seen_root=1
      ROOT="$2"
      shift 2
      ;;
    --systemd-dir)
      ((seen_systemd_dir == 0)) || usage_error 'duplicate --systemd-dir'
      (($# >= 2)) || usage_error 'missing value for --systemd-dir'
      seen_systemd_dir=1
      SYSTEMD_DIR="$2"
      shift 2
      ;;
    --apply)
      ((seen_apply == 0)) || usage_error 'duplicate --apply'
      seen_apply=1
      APPLY=1
      shift
      ;;
    --confirm)
      ((seen_confirm == 0)) || usage_error 'duplicate --confirm'
      (($# >= 2)) || usage_error 'missing value for --confirm'
      seen_confirm=1
      CONFIRM="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

[[ "$ROOT" == /* ]] || usage_error '--root must be absolute'
[[ "$SYSTEMD_DIR" == /* ]] || usage_error '--systemd-dir must be absolute'
ROOT="${ROOT%/}"
SYSTEMD_DIR="${SYSTEMD_DIR%/}"
[[ -n "$ROOT" && "$ROOT" != '/' ]] || usage_error 'unsafe --root'
[[ -n "$SYSTEMD_DIR" && "$SYSTEMD_DIR" != '/' ]] || usage_error 'unsafe --systemd-dir'
if ((APPLY)); then
  [[ "$CONFIRM" == "$CONFIRMATION" ]] || usage_error "--apply requires exact --confirm $CONFIRMATION"
elif ((seen_confirm)); then
  usage_error '--confirm is valid only with --apply'
fi

SOURCE_DIR="$ROOT/infra/systemd"
POLICY_MODULE="$ROOT/lib/cloud_runtime_path_policy.mjs"
[[ -d "$ROOT" && ! -L "$ROOT" ]] || fail 'repository root must be a real directory'
[[ "$(cd -- "$ROOT" && pwd -P)" == "$ROOT" ]] || fail 'repository root path must be canonical'
[[ -d "$SOURCE_DIR" && ! -L "$SOURCE_DIR" ]] || fail 'tracked systemd source directory is missing or unsafe'
[[ -f "$POLICY_MODULE" && ! -L "$POLICY_MODULE" ]] || fail 'runtime path policy module is missing or unsafe'
if [[ -e "$SYSTEMD_DIR" || -L "$SYSTEMD_DIR" ]]; then
  [[ -d "$SYSTEMD_DIR" && ! -L "$SYSTEMD_DIR" ]] || fail 'systemd directory must be a real directory'
  [[ "$(cd -- "$SYSTEMD_DIR" && pwd -P)" == "$SYSTEMD_DIR" ]] || fail 'systemd directory path must be canonical'
fi
if ((APPLY)) && [[ "$SYSTEMD_DIR" == '/etc/systemd/system' ]] && ((EUID != 0)); then
  fail 'applying to /etc/systemd/system requires root'
fi

policy_output="$({
  node --input-type=module - "$POLICY_MODULE" "$SOURCE_DIR" <<'NODE'
import {pathToFileURL} from 'node:url';

const [moduleFile, systemdSource] = process.argv.slice(2);
const policy = await import(pathToFileURL(moduleFile).href);
const services = await policy.discoverCloudRuntimeServices(systemdSource);
const validation = policy.validateCloudRuntimePathPolicy(services);
if (!validation.ok) throw new Error(JSON.stringify(validation));
for (const service of services) {
  const value = policy.CLOUD_RUNTIME_PATH_POLICY_BY_SERVICE[service];
  process.stdout.write(`${service}\t${value.profiles}\t${value.state}\t${value.outputs}\n`);
}
NODE
} 2>&1)" || fail "service policy discovery failed: $policy_output"

mapfile -t policy_rows <<<"$policy_output"
(( ${#policy_rows[@]} > 0 )) || fail 'service policy discovery returned no rows'
declare -A profiles_by_service=()
declare -A state_by_service=()
declare -A outputs_by_service=()
for row in "${policy_rows[@]}"; do
  IFS=$'\t' read -r service profiles state outputs extra <<<"$row"
  [[ -n "$service" && -n "$profiles" && -n "$state" && -n "$outputs" && -z "${extra:-}" ]] \
    || fail "invalid policy row: $row"
  [[ "$service" =~ ^shein-bi-[A-Za-z0-9_.@-]+\.service$ ]] || fail "invalid policy service: $service"
  [[ "$profiles" == none || "$profiles" == host-ro || "$profiles" == rw ]] || fail "invalid profiles policy for $service"
  [[ "$state" == ro || "$state" == rw ]] || fail "invalid state policy for $service"
  [[ "$outputs" == ro || "$outputs" == rw ]] || fail "invalid outputs policy for $service"
  [[ -z "${profiles_by_service[$service]+present}" ]] || fail "duplicate service policy: $service"
  profiles_by_service[$service]="$profiles"
  state_by_service[$service]="$state"
  outputs_by_service[$service]="$outputs"
done

render_service() {
  local service="$1"
  node --input-type=module - "$POLICY_MODULE" "$service" \
    "${profiles_by_service[$service]}" "${state_by_service[$service]}" "${outputs_by_service[$service]}" <<'NODE'
import {pathToFileURL} from 'node:url';
const [moduleFile, service, profiles, state, outputs] = process.argv.slice(2);
const policy = await import(pathToFileURL(moduleFile).href);
process.stdout.write(policy.renderCloudRuntimePathDropIn(service, {profiles, state, outputs}));
NODE
}

target_exists() {
  [[ -e "$1" || -L "$1" ]]
}

validate_target() {
  local service="$1"
  local target="$2"
  [[ -f "$target" && ! -L "$target" ]] || fail "runtime path drop-in target is unsafe: $target"
  cmp -s -- "$target" <(render_service "$service") \
    || fail "runtime path drop-in template drift: $target"
}

if [[ -d "$SYSTEMD_DIR" ]]; then
  shopt -s nullglob
  for target in "$SYSTEMD_DIR"/shein-bi-*.service.d/50-runtime-paths.conf; do
    service_dir="$(basename -- "$(dirname -- "$target")")"
    discovered_service="${service_dir%.d}"
    [[ -n "${profiles_by_service[$discovered_service]+present}" ]] \
      || fail "runtime path drop-in exists for service without policy: $target"
  done
  shopt -u nullglob
fi

planned_install=0
unchanged=0
for service in "${!profiles_by_service[@]}"; do
  target_dir="$SYSTEMD_DIR/$service.d"
  target="$target_dir/50-runtime-paths.conf"
  if [[ -e "$target_dir" || -L "$target_dir" ]]; then
    [[ -d "$target_dir" && ! -L "$target_dir" ]] || fail "unsafe drop-in directory: $target_dir"
  fi
  if target_exists "$target"; then
    validate_target "$service" "$target"
    ((unchanged += 1))
  else
    ((planned_install += 1))
  fi
done

if ((!APPLY)); then
  printf '{"ok":true,"mode":"audit","policyCount":%d,"plannedInstall":%d,"unchanged":%d,"confirmation":"%s"}\n' \
    "${#profiles_by_service[@]}" "$planned_install" "$unchanged" "$CONFIRMATION"
  exit 0
fi

if [[ "$SYSTEMCTL_BIN" == */* ]]; then
  [[ -x "$SYSTEMCTL_BIN" && ! -d "$SYSTEMCTL_BIN" ]] || fail 'configured systemctl binary is not executable'
else
  command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1 || fail 'systemctl command is unavailable'
fi
# Provision only the browser startup leaf; never change the parent locks owner.
[[ "$RUNTIME_ROOT" == /* && -d "$RUNTIME_ROOT/locks" && ! -L "$RUNTIME_ROOT/locks" ]] \
  || fail 'runtime locks parent must be an existing absolute directory'
[[ "$(cd -- "$RUNTIME_ROOT/locks" && pwd -P)" == "$RUNTIME_ROOT/locks" ]] \
  || fail 'runtime locks parent must be canonical'
startup_dir="$RUNTIME_ROOT/locks/chrome-profile-startup"
[[ ! -L "$startup_dir" && ( ! -e "$startup_dir" || -d "$startup_dir" ) ]] \
  || fail 'browser startup directory is unsafe'
if [[ ! -e "$SYSTEMD_DIR" ]]; then
  install -d -m 0755 -- "$SYSTEMD_DIR"
fi
install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0750 -- "$startup_dir"

for service in "${!profiles_by_service[@]}"; do
  target_dir="$SYSTEMD_DIR/$service.d"
  target="$target_dir/50-runtime-paths.conf"
  if [[ -e "$target_dir" || -L "$target_dir" ]]; then
    [[ -d "$target_dir" && ! -L "$target_dir" ]] || fail "unsafe drop-in directory during apply: $target_dir"
  else
    install -d -m 0755 -- "$target_dir"
  fi
  if target_exists "$target"; then
    validate_target "$service" "$target"
    continue
  fi
  tmp="$(mktemp "$target_dir/.50-runtime-paths.conf.XXXXXX")"
  if ! render_service "$service" >"$tmp"; then
    rm -f -- "$tmp"
    fail "failed to render runtime path drop-in: $service"
  fi
  chmod 0644 "$tmp"
  if ! mv -- "$tmp" "$target"; then
    rm -f -- "$tmp"
    fail "failed to publish runtime path drop-in: $target"
  fi
  validate_target "$service" "$target"
done

for service in "${!profiles_by_service[@]}"; do
  validate_target "$service" "$SYSTEMD_DIR/$service.d/50-runtime-paths.conf"
done

"$SYSTEMCTL_BIN" daemon-reload || fail 'systemctl daemon-reload failed'
printf '{"ok":true,"mode":"apply","policyCount":%d,"installed":%d,"unchanged":%d,"daemonReload":true}\n' \
  "${#profiles_by_service[@]}" "$planned_install" "$unchanged"
