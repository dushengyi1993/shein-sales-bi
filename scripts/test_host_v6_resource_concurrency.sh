#!/usr/bin/env bash
set -Eeuo pipefail
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d /tmp/shein-v6-resources-XXXXXX)"
PIDS=()
cleanup() {
  touch "$TEST_ROOT/release" 2>/dev/null || true
  for child in "${PIDS[@]}"; do kill "$child" 2>/dev/null || true; done
  for child in "${PIDS[@]}"; do wait "$child" 2>/dev/null || true; done
  [[ "$TEST_ROOT" == /tmp/shein-v6-resources-* ]] && rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT
mkdir -p "$TEST_ROOT/scripts/lib" "$TEST_ROOT/bin" "$TEST_ROOT/state/locks"
cp "$SOURCE_ROOT/scripts/run_host_heavy_job.sh" "$SOURCE_ROOT/scripts/run_host_browser_read_job.sh" "$TEST_ROOT/scripts/"
cp "$SOURCE_ROOT/scripts/lib/shared_lock.sh" "$TEST_ROOT/scripts/lib/"
printf '#!/bin/sh\nexit "${V6_PRESSURE_EXIT:-0}"\n' > "$TEST_ROOT/bin/node"
chmod +x "$TEST_ROOT/bin/node"
export PATH="$TEST_ROOT/bin:$PATH"
export SHEIN_BI_ROOT="$TEST_ROOT"
export SHEIN_HOST_HEAVY_LOCK_FILE="$TEST_ROOT/host.lock"
export SHEIN_BROWSER_READ_SLOT_0="$TEST_ROOT/browser-0.lock"
export SHEIN_BROWSER_READ_SLOT_1="$TEST_ROOT/browser-1.lock"
touch "$SHEIN_HOST_HEAVY_LOCK_FILE" "$SHEIN_BROWSER_READ_SLOT_0" "$SHEIN_BROWSER_READ_SLOT_1"
wait_file() { for ((i=0;i<150;i++)); do [[ -f "$1" ]] && return 0; sleep .02; done; echo "missing marker: $1" >&2; return 1; }
hold='touch "$1"; while [[ ! -f "$2" ]]; do sleep .05; done'
flock -x "$SHEIN_HOST_HEAVY_LOCK_FILE" bash -c "$hold" -- "$TEST_ROOT/exclusive-ready" "$TEST_ROOT/release-host" &
PIDS+=("$!")
wait_file "$TEST_ROOT/exclusive-ready"
bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain independent-api --class openapi -- touch "$TEST_ROOT/api-ran"
test -f "$TEST_ROOT/api-ran"
touch "$TEST_ROOT/release-host"
wait "${PIDS[0]}"

bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain profile-dl --class browser -- bash -c "$hold" -- "$TEST_ROOT/browser-one" "$TEST_ROOT/release" &
PIDS+=("$!")
wait_file "$TEST_ROOT/browser-one"
bash "$TEST_ROOT/scripts/run_host_browser_read_job.sh" --domain profile-fy -- bash -c "$hold" -- "$TEST_ROOT/browser-two" "$TEST_ROOT/release" &
PIDS+=("$!")
wait_file "$TEST_ROOT/browser-two"
set +e
bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain third-browser --class browser -- touch "$TEST_ROOT/third-ran"
third_status=$?
bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain profile-dl --class browser -- touch "$TEST_ROOT/same-domain-ran"
same_status=$?
set -e
test "$third_status" -eq 75
test "$same_status" -eq 75
test ! -e "$TEST_ROOT/third-ran"
test ! -e "$TEST_ROOT/same-domain-ran"
bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain independent-api-two --class openapi -- touch "$TEST_ROOT/api-two-ran"
bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain isolated-materializer --class materializer -- touch "$TEST_ROOT/materializer-ran"
test -f "$TEST_ROOT/api-two-ran"
test -f "$TEST_ROOT/materializer-ran"
set +e
V6_PRESSURE_EXIT=75 bash "$TEST_ROOT/scripts/run_host_heavy_job.sh" --domain pressured-job --class materializer -- touch "$TEST_ROOT/pressure-ran"
pressure_status=$?
set -e
test "$pressure_status" -eq 75
test ! -e "$TEST_ROOT/pressure-ran"
touch "$TEST_ROOT/release"
for child in "${PIDS[@]}"; do wait "$child"; done
printf 'PASS: independent OpenAPI, shared browser capacity, same-domain exclusion, materializer isolation, pressure gate\n'
