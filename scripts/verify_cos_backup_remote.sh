#!/usr/bin/env bash
# Secure launcher for the independent COS remote-object verifier.
#
# systemd injects the three credential files through LoadCredential= into
# $CREDENTIALS_DIRECTORY.  This launcher only turns the credential
# directory into the three FILE PATH variables the verifier reads; no secret
# value ever enters the environment, the command line, Git, or service logs.
# Operators running a manual acceptance run may export the three
# SHEIN_BI_COS_VERIFY_* file vars directly and leave CREDENTIALS_DIRECTORY
# unset.
set -euo pipefail

APP_DIR="${SHEIN_BI_APP_DIR:-/opt/shein-bi/app}"
VERIFIER="${SHEIN_BI_COS_VERIFY_MJS:-$APP_DIR/scripts/verify_cos_backup_remote.mjs}"

resolve_credential_path() {
  local var_name="$1" credential_name="$2"
  local value="${!var_name:-}"
  if [[ -z "$value" && -n "${CREDENTIALS_DIRECTORY:-}" ]]; then
    value="$CREDENTIALS_DIRECTORY/$credential_name"
  fi
  if [[ -z "$value" ]]; then
    echo "cos-verify-error code=COS_CREDENTIAL_PATH_MISSING name=$var_name" >&2
    exit 78
  fi
  printf -v "$var_name" '%s' "$value"
  export "$var_name=$value"
}
resolve_credential_path SHEIN_BI_COS_VERIFY_SECRET_FILE shein-bi-cos-verify-secret
resolve_credential_path SHEIN_BI_COS_VERIFY_TARGET_FILE shein-bi-cos-verify-target
resolve_credential_path SHEIN_BI_COS_VERIFY_TARGET_SHA_FILE shein-bi-cos-verify-target-sha

exec node "$VERIFIER" "$@"
