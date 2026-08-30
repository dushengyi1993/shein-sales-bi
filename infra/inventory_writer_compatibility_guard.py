#!/usr/bin/python3
"""Checkout-independent systemd pre-start guard for inventory writers."""

import argparse
import datetime
import grp
import hashlib
import json
import os
import pwd
import re
import stat
import subprocess
import sys

ACTIVATION_SCHEMA = "inventory-v2-reader-first-activation/v1"
RECEIPT_SCHEMA = "inventory-v2-reader-first-activation-receipt/v1"
COMPATIBILITY_RECORD_SCHEMA = "inventory-v2-compatibility-record/v1"
COMPATIBILITY_RECEIPT_SCHEMA = "inventory-v2-compatibility-receipt/v1"
READER_SCHEMA = "inventory-manual-resolution/v1"
DEFAULT_APP_ROOT = "/opt/shein-bi/app"
DEFAULT_CONTROL_DIR = "/var/lib/shein-bi-control/inventory-writer-compatibility"
DEFAULT_ACTIVATION = f"{DEFAULT_CONTROL_DIR}/activation.ndjson"
DEFAULT_RECEIPT = f"{DEFAULT_CONTROL_DIR}/activation.receipt.json"
DEFAULT_COMPATIBILITY = f"{DEFAULT_CONTROL_DIR}/compatibility.ndjson"
DEFAULT_COMPATIBILITY_RECEIPT = f"{DEFAULT_CONTROL_DIR}/compatibility.receipt.json"
DEFAULT_SERVICE_GROUP = "sheinops"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
REQUIRED_INTENT_ID = "e07f999c-96b2-460c-bfa9-fa924f410ec3"
REQUIRED_RESTART_GENERATION_UNITS = {
    "shein-bi-daily-inventory-replenishment-guard.service",
    "shein-bi-et-low-inventory-guard.service",
    "shein-bi-et-low-inventory-recheck.service",
}
RUNTIME_ALLOWLIST = ("state", "tmp", "outputs", "profiles", "node_modules")
MAJOR_MINOR = re.compile(r"^\d+:\d+$")
NSENTER_PATH = "/usr/bin/nsenter"
SELF_MOUNT_NAMESPACE = "/proc/self/ns/mnt"
HOST_MOUNT_NAMESPACE = "/proc/1/ns/mnt"
MOUNT_NAMESPACE_REEXEC_MARKER = "_SHEIN_BI_INVENTORY_WRITER_GUARD_HOST_MOUNT_NAMESPACE"


class GuardError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise GuardError(code, message)


def resolve_service_uid(service_group=DEFAULT_SERVICE_GROUP):
    """Resolve the writer uid from its service group name.

    A zero result deliberately means either root or an unresolved identity;
    callers therefore retain the strict root-only parent-owner policy.
    """
    try:
        if not isinstance(service_group, str) or not service_group:
            return 0
        if service_group.isdigit():
            group_name = grp.getgrgid(int(service_group)).gr_name
        else:
            group_name = service_group
            grp.getgrnam(group_name)
        uid = pwd.getpwnam(group_name).pw_uid
        return uid if isinstance(uid, int) and not isinstance(uid, bool) and uid >= 0 else 0
    except (KeyError, OSError, TypeError, ValueError, OverflowError):
        return 0


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def stable_hash(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def valid_iso(value):
    if not isinstance(value, str) or not ISO_Z.fullmatch(value):
        return False
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ")
        return True
    except ValueError:
        return False


def exact_keys(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", f"{label} keys")


def secure_regular(path, label, executable=False):
    try:
        info = os.lstat(path)
    except OSError as error:
        fail("INVENTORY_WRITER_GUARD_FILE_UNREADABLE", f"{label}:{error.errno}")
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        fail("INVENTORY_WRITER_GUARD_FILE_UNSAFE", f"{label}:type-or-links")
    if info.st_uid != 0 or info.st_mode & 0o022:
        fail("INVENTORY_WRITER_GUARD_FILE_PERMISSION_DRIFT", f"{label}:uid={info.st_uid}:mode={oct(info.st_mode & 0o7777)}")
    if executable and not info.st_mode & 0o111:
        fail("INVENTORY_WRITER_GUARD_FILE_PERMISSION_DRIFT", f"{label}:not-executable")
    return info


def secure_parent_chain(path, label, trust_root="/"):
    boundary = os.path.abspath(trust_root)
    current = os.path.abspath(os.path.dirname(path))
    if os.path.commonpath([current, boundary]) != boundary:
        fail("INVENTORY_WRITER_GUARD_DIRECTORY_PERMISSION_DRIFT", f"{label}:outside-trust-root")
    while True:
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            fail("INVENTORY_WRITER_GUARD_DIRECTORY_PERMISSION_DRIFT", f"{label}:{current}")
        if current == boundary:
            return
        parent = os.path.dirname(current)
        if parent == current:
            fail("INVENTORY_WRITER_GUARD_DIRECTORY_PERMISSION_DRIFT", f"{label}:trust-root-not-reached")
        current = parent


def validate_guard_executable(args):
    executable_path = os.path.abspath(__file__)
    secure_parent_chain(executable_path, "guard executable", args.filesystem_trust_root)
    secure_regular(executable_path, "guard executable", executable=True)
    return executable_path


def mount_namespace_identity(path):
    try:
        info = os.stat(path)
    except OSError as error:
        fail("INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_UNAVAILABLE", f"{path}:{error.errno}")
    return info.st_dev, info.st_ino


def validate_nsenter_executable():
    secure_parent_chain(NSENTER_PATH, "nsenter executable", "/")
    secure_regular(NSENTER_PATH, "nsenter executable", executable=True)


def reexec_in_host_mount_namespace(executable_path, argv=None, environment=None):
    self_identity = mount_namespace_identity(SELF_MOUNT_NAMESPACE)
    host_identity = mount_namespace_identity(HOST_MOUNT_NAMESPACE)
    if self_identity == host_identity:
        return False

    source_environment = os.environ if environment is None else environment
    if MOUNT_NAMESPACE_REEXEC_MARKER in source_environment:
        fail(
            "INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_LOOP",
            f"marker-present:self={self_identity[0]}:{self_identity[1]}:host={host_identity[0]}:{host_identity[1]}",
        )

    original_argv = list(sys.argv if argv is None else argv)
    if not original_argv or not isinstance(original_argv[0], str) or not original_argv[0] \
            or any(not isinstance(value, str) or "\0" in value for value in original_argv) \
            or original_argv[0] != executable_path:
        fail("INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_INVALID", "guard argv")

    validate_nsenter_executable()
    reexec_environment = dict(source_environment)
    reexec_environment[MOUNT_NAMESPACE_REEXEC_MARKER] = f"{host_identity[0]}:{host_identity[1]}"
    command = [NSENTER_PATH, f"--mount={HOST_MOUNT_NAMESPACE}", "--", *original_argv]
    try:
        result = subprocess.run(
            command, stdin=subprocess.DEVNULL, check=False, env=reexec_environment,
        )
    except OSError as error:
        fail("INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_FAILED", f"exec:{error.errno}")
    if result.returncode != 0:
        fail("INVENTORY_WRITER_GUARD_MOUNT_NAMESPACE_REEXEC_FAILED", f"nsenter:{result.returncode}")
    return True


def read_bytes(path, maximum, label, trust_root="/"):
    secure_parent_chain(path, label, trust_root)
    info = secure_regular(path, label)
    if info.st_size < 1 or info.st_size > maximum:
        fail("INVENTORY_WRITER_GUARD_FILE_SIZE_INVALID", label)
    with open(path, "rb") as source:
        data = source.read(maximum + 1)
    if len(data) != info.st_size:
        fail("INVENTORY_WRITER_GUARD_FILE_RACE", label)
    return data


def parse_json(data, label):
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVENTORY_WRITER_GUARD_JSON_INVALID", label)


def validate_authority(authority):
    exact_keys(authority, [
        "deployedCommit", "sourceFingerprint", "bundleSha256", "trackedSourceClean",
        "releaseReceiptKind", "releaseReceiptHash", "releaseReceiptFile", "writerServices", "capturedAt",
    ], "authority")
    if not HEX40.fullmatch(str(authority["deployedCommit"])):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority deployedCommit")
    for key in ("sourceFingerprint", "bundleSha256", "releaseReceiptHash"):
        if not HEX64.fullmatch(str(authority[key])):
            fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", f"authority {key}")
    if authority["trackedSourceClean"] is not True or authority["releaseReceiptKind"] not in ("formal", "emergency"):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority source/receipt")
    if not isinstance(authority["releaseReceiptFile"], str) or not authority["releaseReceiptFile"].startswith("/"):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority releaseReceiptFile")
    if not isinstance(authority["writerServices"], list) or not authority["writerServices"]:
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority writerServices")
    units = []
    for service in authority["writerServices"]:
        if not isinstance(service, dict) or not isinstance(service.get("unit"), str) \
                or not service["unit"] or not HEX64.fullmatch(str(service.get("generationHash", ""))):
            fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority writerServices generation")
        units.append(service["unit"])
    if len(units) != len(set(units)) or not REQUIRED_RESTART_GENERATION_UNITS.issubset(units):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority writerServices required generation")
    if not valid_iso(authority["capturedAt"]):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "authority capturedAt")


def validate_activation(record):
    exact_keys(record, [
        "schemaVersion", "kind", "readerSchemaVersion", "authority",
        "requiredManualResolution", "activatedAt", "activationHash",
    ], "activation")
    if record["schemaVersion"] != ACTIVATION_SCHEMA or record["kind"] != "reader_first_activation" or record["readerSchemaVersion"] != READER_SCHEMA:
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "activation version/kind")
    validate_authority(record["authority"])
    required = record["requiredManualResolution"]
    exact_keys(required, ["intentId", "scopeKey", "journalFile", "receiptFile"], "requiredManualResolution")
    if required["intentId"] != REQUIRED_INTENT_ID or not HEX64.fullmatch(str(required["scopeKey"])):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "required manual resolution identity")
    if not str(required["journalFile"]).startswith("/") or not str(required["receiptFile"]).startswith("/"):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "required manual resolution paths")
    if not valid_iso(record["activatedAt"]):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "activation activatedAt")
    core = dict(record)
    claimed = core.pop("activationHash")
    if not HEX64.fullmatch(str(claimed)) or stable_hash(core) != claimed:
        fail("INVENTORY_WRITER_GUARD_ACTIVATION_HASH_INVALID", "activation hash")


def validate_receipt(receipt, activation_path, registry_sha, activation_hash):
    exact_keys(receipt, [
        "schemaVersion", "kind", "activationFile", "activationFileSha256",
        "activationHash", "recordedAt", "receiptHash",
    ], "activation receipt")
    if receipt["schemaVersion"] != RECEIPT_SCHEMA or receipt["kind"] != "reader_first_activation_receipt":
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "receipt version/kind")
    if not valid_iso(receipt["recordedAt"]):
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "receipt recordedAt")
    core = dict(receipt)
    claimed = core.pop("receiptHash")
    if stable_hash(core) != claimed:
        fail("INVENTORY_WRITER_GUARD_RECEIPT_HASH_INVALID", "receipt hash")
    if os.path.abspath(receipt["activationFile"]) != os.path.abspath(activation_path) \
            or receipt["activationFileSha256"] != registry_sha or receipt["activationHash"] != activation_hash:
        fail("INVENTORY_WRITER_GUARD_RECEIPT_BINDING_INVALID", "receipt registry binding")


def authority_identity(authority):
    return {key: authority[key] for key in (
        "deployedCommit", "sourceFingerprint", "bundleSha256", "trackedSourceClean",
        "releaseReceiptKind", "releaseReceiptHash", "releaseReceiptFile",
    )}


def authority_release_identity(authority):
    return {key: authority[key] for key in (
        "deployedCommit", "bundleSha256", "trackedSourceClean",
        "releaseReceiptKind", "releaseReceiptHash", "releaseReceiptFile",
    )}


def validate_candidate_authority(authority):
    exact_keys(authority, [
        "deployedCommit", "sourceFingerprint", "bundleSha256", "trackedSourceClean",
        "releaseReceiptKind", "releaseReceiptHash", "releaseReceiptFile",
    ], "candidate authority")
    if not HEX40.fullmatch(str(authority["deployedCommit"])) \
            or authority["trackedSourceClean"] is not True \
            or authority["releaseReceiptKind"] not in ("formal", "emergency") \
            or not isinstance(authority["releaseReceiptFile"], str) \
            or not authority["releaseReceiptFile"].startswith("/"):
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "candidate authority identity")
    for key in ("sourceFingerprint", "bundleSha256", "releaseReceiptHash"):
        if not HEX64.fullmatch(str(authority[key])):
            fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", f"candidate authority {key}")


def validate_record_hash(record):
    if not isinstance(record, dict):
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "record object")
    core = dict(record)
    claimed = core.pop("recordHash", "")
    if not HEX64.fullmatch(str(claimed)) or stable_hash(core) != claimed:
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "record hash")


def validate_maintenance_evidence(value):
    exact_keys(value, ["generation", "hash"], "compatibility maintenance")
    if not isinstance(value["generation"], int) or value["generation"] < 1 \
            or not HEX64.fullmatch(str(value["hash"])):
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "maintenance evidence")


def validate_compatibility_registry(data, activation):
    try:
        lines = [line for line in data.decode("utf-8").splitlines() if line.strip()]
        records = [json.loads(line) for line in lines]
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "registry JSON")
    if not records:
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "registry empty")
    active = None
    pending = None
    for index, record in enumerate(records):
        validate_record_hash(record)
        if record.get("schemaVersion") != COMPATIBILITY_RECORD_SCHEMA or not valid_iso(record.get("recordedAt")):
            fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", f"record schema:{index + 1}")
        kind = record.get("kind")
        if kind == "compatibility_initial":
            exact_keys(record, [
                "schemaVersion", "kind", "generation", "activationHash", "authority",
                "requiredManualResolutionHash", "recordedAt", "recordHash",
            ], "compatibility initial")
            validate_authority(record["authority"])
            if index != 0 or active is not None or record["generation"] != 1 \
                    or record["activationHash"] != activation["activationHash"] \
                    or record["requiredManualResolutionHash"] != stable_hash(activation["requiredManualResolution"]) \
                    or authority_identity(record["authority"]) != authority_identity(activation["authority"]):
                fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "initial binding")
            active = record
        elif kind == "compatibility_rotation_staged":
            exact_keys(record, [
                "schemaVersion", "kind", "generation", "previousGeneration", "previousFinalizedHash",
                "candidateAuthority", "currentStateHash", "maintenance", "recordedAt", "recordHash",
            ], "compatibility stage")
            validate_candidate_authority(record["candidateAuthority"])
            validate_maintenance_evidence(record["maintenance"])
            if active is None or pending is not None or record["generation"] != active["generation"] + 1 \
                    or record["previousGeneration"] != active["generation"] \
                    or record["previousFinalizedHash"] != active["recordHash"] \
                    or not HEX64.fullmatch(str(record["currentStateHash"])):
                fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "stage chain")
            pending = record
        elif kind == "compatibility_rotation_finalized":
            exact_keys(record, [
                "schemaVersion", "kind", "generation", "previousGeneration", "previousFinalizedHash",
                "stageHash", "currentStateHash", "authority", "maintenance", "recordedAt", "recordHash",
            ], "compatibility finalize")
            validate_authority(record["authority"])
            validate_maintenance_evidence(record["maintenance"])
            if active is None or pending is None or record["generation"] != pending["generation"] \
                    or record["previousGeneration"] != active["generation"] \
                    or record["previousFinalizedHash"] != active["recordHash"] \
                    or record["stageHash"] != pending["recordHash"] \
                    or not HEX64.fullmatch(str(record["currentStateHash"])) \
                    or authority_release_identity(record["authority"]) \
                    != authority_release_identity(pending["candidateAuthority"]):
                fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "finalize chain")
            active = record
            pending = None
        else:
            fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", f"unknown record kind:{kind}")
    return {"records": records, "active": active, "pending": pending}


def validate_compatibility_receipt(receipt, compatibility_path, registry_sha, state):
    exact_keys(receipt, [
        "schemaVersion", "kind", "compatibilityFile", "compatibilityFileSha256", "lastRecordHash",
        "activeGeneration", "activeRecordHash", "pendingStageHash", "recordedAt", "receiptHash",
    ], "compatibility receipt")
    if receipt["schemaVersion"] != COMPATIBILITY_RECEIPT_SCHEMA \
            or receipt["kind"] != "inventory_compatibility_receipt" or not valid_iso(receipt["recordedAt"]):
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "receipt schema")
    core = dict(receipt)
    claimed = core.pop("receiptHash")
    expected_pending = state["pending"]["recordHash"] if state["pending"] else ""
    if stable_hash(core) != claimed or os.path.abspath(receipt["compatibilityFile"]) != os.path.abspath(compatibility_path) \
            or receipt["compatibilityFileSha256"] != registry_sha \
            or receipt["lastRecordHash"] != state["records"][-1]["recordHash"] \
            or receipt["activeGeneration"] != state["active"]["generation"] \
            or receipt["activeRecordHash"] != state["active"]["recordHash"] \
            or receipt["pendingStageHash"] != expected_pending:
        fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "receipt binding")


def git(app_root, *arguments, binary=False):
    environment = dict(os.environ)
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    result = subprocess.run(
        ["git", "-c", f"safe.directory={app_root}", *arguments], cwd=app_root,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, env=environment,
    )
    if result.returncode != 0:
        fail("INVENTORY_WRITER_GUARD_GIT_FAILED", f"git {' '.join(arguments)}:{result.returncode}")
    return result.stdout if binary else result.stdout.decode("utf-8").strip()


def path_is_under(root, target):
    root = os.path.normpath(os.path.abspath(root))
    target = os.path.normpath(os.path.abspath(target))
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        return False


def ensure_no_symlink_components(app_root, target):
    app_root = os.path.normpath(os.path.abspath(app_root))
    target = os.path.normpath(os.path.abspath(target))
    if not path_is_under(app_root, target):
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"path outside app root:{target}")
    current = app_root
    info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"unsafe app root:{app_root}")
    relative = os.path.relpath(target, app_root)
    if relative == ".":
        return
    components = relative.split(os.sep)
    for index, component in enumerate(components):
        if component in ("", ".", ".."):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"invalid path component:{target}")
        current = os.path.join(current, component)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"symlink path component:{current}")
        if index < len(components) - 1 and not stat.S_ISDIR(info.st_mode):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"non-directory path component:{current}")


def decode_mountinfo_field(value):
    def decode(match):
        return chr(int(match.group(1), 8))

    return re.sub(r"\\([0-7]{3})", decode, value)


def validate_mount_identity(identity):
    if not isinstance(identity, dict) or set(identity) != {"mountId", "mountpoint", "root", "majorMinor", "roRw"} \
            or not isinstance(identity["mountId"], int) or isinstance(identity["mountId"], bool) \
            or identity["mountId"] < 1 or not isinstance(identity["mountpoint"], str) \
            or not os.path.isabs(identity["mountpoint"]) \
            or os.path.normpath(identity["mountpoint"]) != identity["mountpoint"] \
            or not isinstance(identity["root"], str) or not identity["root"].startswith("/") \
            or not isinstance(identity["majorMinor"], str) or not MAJOR_MINOR.fullmatch(identity["majorMinor"]) \
            or identity["roRw"] not in ("ro", "rw"):
        fail("INVENTORY_WRITER_GUARD_MOUNT_IDENTITY_INVALID", "mount identity")


def mountinfo_entries():
    try:
        stream = open("/proc/self/mountinfo", "r", encoding="utf-8")
    except OSError as error:
        fail("INVENTORY_WRITER_GUARD_MOUNT_INVENTORY_UNAVAILABLE", str(error))
    entries = []
    with stream:
        for line in stream:
            head, separator, tail = line.rstrip("\n").partition(" - ")
            if not separator:
                fail("INVENTORY_WRITER_GUARD_MOUNT_INVENTORY_INVALID", "mountinfo separator")
            fields = head.split()
            post_fields = tail.split()
            if len(fields) < 6 or len(post_fields) < 3 or not fields[0].isdigit():
                fail("INVENTORY_WRITER_GUARD_MOUNT_INVENTORY_INVALID", "mountinfo fields")
            mount_options = fields[5].split(",")
            super_options = post_fields[2].split(",")
            identity = {
                "mountId": int(fields[0]),
                "mountpoint": os.path.normpath(decode_mountinfo_field(fields[4])),
                "root": decode_mountinfo_field(fields[3]),
                "majorMinor": fields[2],
                "roRw": "ro" if "ro" in mount_options or "ro" in super_options else "rw",
            }
            if not identity["root"].startswith("/"):
                # Namespace mounts (mnt/net/user/ipc/uts/pid/time:[...]) are not
                # filesystem runtime roots and are never under the app root.
                continue
            validate_mount_identity(identity)
            entries.append(identity)
    return entries


def source_authority_paths(app_root, tracked):
    values = {app_root}
    git_path = os.path.join(app_root, ".git")
    try:
        git_info = os.lstat(git_path)
    except OSError as error:
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f".git:{error.errno}")
    if not stat.S_ISDIR(git_info.st_mode) or stat.S_ISLNK(git_info.st_mode):
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", ".git must be a real directory")
    def walk_error(error):
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f".git walk:{error}")

    for current, directories, files in os.walk(git_path, followlinks=False, onerror=walk_error):
        values.add(current)
        values.update(os.path.join(current, name) for name in directories + files)
    for relative in tracked:
        candidate = os.path.normpath(os.path.abspath(os.path.join(app_root, relative)))
        if not os.path.lexists(candidate):
            fail("INVENTORY_WRITER_GUARD_CHECKOUT_NOT_CLEAN", f"tracked path missing:{relative}")
        values.add(candidate)
        current = os.path.dirname(candidate)
        while current != app_root:
            if not path_is_under(app_root, current):
                fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"tracked path outside app root:{relative}")
            values.add(current)
            current = os.path.dirname(current)
    result = sorted(values)
    for candidate in result:
        ensure_no_symlink_components(app_root, candidate)
    return result


def runtime_permission_scope(app_root, source_paths):
    app_info = os.lstat(app_root)
    source_set = set(source_paths)
    git_path = os.path.join(app_root, ".git")
    mounts = []
    for identity in mountinfo_entries():
        mountpoint = identity["mountpoint"]
        if not path_is_under(app_root, mountpoint):
            continue
        if mountpoint == app_root:
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", "app root mount")
        relative = os.path.relpath(mountpoint, app_root).replace(os.sep, "/")
        first = relative.split("/", 1)[0]
        exact_runtime_root = relative in RUNTIME_ALLOWLIST
        if path_is_under(git_path, mountpoint):
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"mount under .git:{mountpoint}")
        if first not in RUNTIME_ALLOWLIST:
            if mountpoint in source_set:
                fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"mount under source:{mountpoint}")
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"external mount outside allowlist:{mountpoint}")
        if mountpoint in source_set and not exact_runtime_root:
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"mount under source:{mountpoint}")
        if any(path != mountpoint and path_is_under(mountpoint, path) for path in source_paths):
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"mount hides tracked source:{mountpoint}")
        mounts.append(identity)
    if len({row["mountpoint"] for row in mounts}) != len(mounts):
        fail("INVENTORY_WRITER_GUARD_MOUNT_IDENTITY_INVALID", "duplicate mountpoint")
    mounts.sort(key=lambda row: (row["mountpoint"], row["mountId"]))

    roots = []
    for name in RUNTIME_ALLOWLIST:
        candidate = os.path.join(app_root, name)
        if not os.path.lexists(candidate):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"runtime root missing:{name}")
        ensure_no_symlink_components(app_root, candidate)
        info = os.lstat(candidate)
        if not stat.S_ISDIR(info.st_mode):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"runtime root is not a directory:{name}")
        exact_mounts = [row for row in mounts if row["mountpoint"] == candidate]
        if len(exact_mounts) > 1:
            fail("INVENTORY_WRITER_GUARD_MOUNT_IDENTITY_INVALID", f"duplicate runtime mount:{name}")
        different_device = info.st_dev != app_info.st_dev
        if different_device and not exact_mounts:
            fail("INVENTORY_WRITER_GUARD_MOUNT_IDENTITY_INVALID", f"runtime mount identity unavailable:{name}")
        hidden_source = [path for path in source_paths if path != candidate and path_is_under(candidate, path)]
        read_only_mode = not stat.S_IMODE(info.st_mode) & 0o222
        if read_only_mode and hidden_source:
            fail("INVENTORY_WRITER_GUARD_MOUNT_SCOPE_INVALID", f"read-only runtime root hides source:{name}")
        external = bool(exact_mounts or different_device)
        reasons = []
        if external:
            reasons.append("external-mount")
        if read_only_mode:
            reasons.append("read-only-mode")
        roots.append({
            "name": name,
            "path": candidate,
            "excluded": bool(reasons),
            "external": external,
            "reasons": reasons,
            "mountIdentity": exact_mounts[0] if exact_mounts else None,
        })
    return roots, mounts


def permission_scope(app_root, tracked):
    source = source_authority_paths(app_root, tracked)
    runtime, external_mounts = runtime_permission_scope(app_root, source)
    runtime_paths = {row["path"] for row in runtime}
    managed_runtime = [row for row in runtime if not row["excluded"]]
    excluded_runtime = [row for row in runtime if row["excluded"]]
    managed_source = [path for path in source if path not in runtime_paths]
    return {
        "appRoot": app_root,
        "sourceAuthorityPaths": source,
        "managedSourcePaths": managed_source,
        "managedRuntimeRoots": managed_runtime,
        "excludedRuntimeRoots": excluded_runtime,
        "externalRuntimeMounts": external_mounts,
    }


def current_source_generation(scope, head):
    fingerprint = {
        "headCommit": head,
        "managedSourcePathCount": len(scope["managedSourcePaths"]),
        "managedSourcePathsSha256": stable_hash(scope["managedSourcePaths"]),
        "managedRuntimeRootsSha256": stable_hash([
            {"name": row["name"], "path": row["path"]} for row in scope["managedRuntimeRoots"]
        ]),
        "externalRuntimeMountsSha256": stable_hash(scope["externalRuntimeMounts"]),
    }
    return {
        "generationId": f"current:{head}", **fingerprint,
        "generationHash": stable_hash(fingerprint),
    }


def validate_external_parent_chain(app_root, service_uid=None):
    """Require the non-root writer's outside checkout parents to be stable."""
    service_uid = resolve_service_uid() if service_uid is None else service_uid
    child = app_root
    current = os.path.dirname(app_root)
    while True:
        try:
            parent_info = os.lstat(current)
            child_info = os.lstat(child)
        except OSError as error:
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"external parent:{current}:{error.errno}")
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode) \
                or not stat.S_ISDIR(child_info.st_mode) or stat.S_ISLNK(child_info.st_mode):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"unsafe external parent:{current}")
        # An unresolved service identity is represented by uid 0 and keeps the
        # previous root-only owner policy.  Once a non-root writer is known,
        # ownership by another non-writable user is safe and ownership by the
        # writer is rejected only when its owner-write bit is set.
        if current != "/" and service_uid == 0 and parent_info.st_uid != 0:
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"external parent not root-owned:{current}")
        mode = stat.S_IMODE(parent_info.st_mode)
        if mode & 0o022 and not (mode & stat.S_ISVTX and child_info.st_uid == 0):
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"external parent permits rename:{current}")
        if service_uid != 0 and parent_info.st_uid == service_uid and mode & 0o200:
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"external parent permits service rename:{current}")
        if current == os.path.dirname(current):
            return
        child = current
        current = os.path.dirname(current)


def validate_source_permissions(app_root, tracked, service_uid=None):
    root = os.lstat(app_root)
    if not stat.S_ISDIR(root.st_mode) or stat.S_ISLNK(root.st_mode) or root.st_uid != 0 \
            or root.st_mode & 0o027:
        fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", "app root must be root-owned 0750-compatible")
    validate_external_parent_chain(app_root, service_uid)
    scope = permission_scope(app_root, tracked)
    source = scope["sourceAuthorityPaths"]
    runtime_by_path = {row["path"]: row for row in scope["managedRuntimeRoots"] + scope["excludedRuntimeRoots"]}
    git_path = os.path.join(app_root, ".git")
    for candidate in source:
        if candidate == app_root:
            continue
        info = os.lstat(candidate)
        if candidate.startswith(git_path + os.sep) or candidate == git_path:
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"mutable .git entry:{candidate}")
    for row in runtime_by_path.values():
        if row["excluded"]:
            # External/read-only roots are evidence-only. Their mount identity
            # is still part of the validated scope, but their mode is not ours.
            if row["external"] and row["mountIdentity"] is None:
                fail("INVENTORY_WRITER_GUARD_MOUNT_IDENTITY_INVALID", f"missing mount identity:{row['name']}")
            continue
        info = os.lstat(row["path"])
        if info.st_uid != 0 or not info.st_mode & stat.S_ISVTX or info.st_mode & 0o002:
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"runtime allowlist root:{row['name']}")
    for relative in tracked:
        candidate = os.path.join(app_root, relative)
        info = os.lstat(candidate)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 \
                or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"mutable tracked source:{relative}")
        current = os.path.dirname(candidate)
        while current != app_root:
            directory = os.lstat(current)
            relative_dir = os.path.relpath(current, app_root).replace(os.sep, "/")
            allowlist_root = relative_dir in RUNTIME_ALLOWLIST
            runtime = runtime_by_path.get(current)
            safe_allowlist = allowlist_root and runtime is not None and not runtime["excluded"] \
                and directory.st_uid == 0 and directory.st_mode & stat.S_ISVTX \
                and not directory.st_mode & 0o002
            if not stat.S_ISDIR(directory.st_mode) or stat.S_ISLNK(directory.st_mode) or directory.st_uid != 0 \
                    or (directory.st_mode & 0o022 and not safe_allowlist):
                fail("INVENTORY_WRITER_GUARD_SOURCE_PERMISSION_DRIFT", f"mutable tracked parent:{relative_dir}")
            current = os.path.dirname(current)
    return scope


def parse_exec_commands(raw):
    structured = [match.group(1).strip() for match in re.finditer(
        r"(?:^|[;{\s])argv\[\]=([^;}]*?)(?=\s*;|\s*\})", raw,
    ) if match.group(1).strip()]
    return structured if structured else ([raw.strip()] if raw.strip() else [])


def validate_execstartpre_last(args, executable_path):
    if not args.unit or not re.fullmatch(r"shein-bi-[A-Za-z0-9_.@-]+\.service", args.unit):
        fail("INVENTORY_WRITER_GUARD_SYSTEMD_CONTRACT_INVALID", "unit")
    result = subprocess.run(
        [args.systemctl_bin, "show", "--no-pager", "--property=ExecStartPre", "--value", args.unit],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, text=True,
    )
    if result.returncode != 0:
        fail("INVENTORY_WRITER_GUARD_SYSTEMD_CONTRACT_INVALID", f"systemctl:{result.returncode}")
    expected = " ".join([
        executable_path, "--unit", args.unit, "--systemctl-bin", args.systemctl_bin,
        "--app-root", args.app_root, "--activation-file", args.activation_file,
        "--activation-receipt-file", args.activation_receipt_file,
        "--compatibility-file", args.compatibility_file,
        "--compatibility-receipt-file", args.compatibility_receipt_file,
    ])
    commands = parse_exec_commands(result.stdout)
    if commands.count(expected) != 1 or not commands or commands[-1] != expected:
        fail("INVENTORY_WRITER_GUARD_NOT_LAST", f"unit={args.unit}:count={commands.count(expected)}")


def validate_checkout(app_root, expected_commits, return_scope=False, service_uid=None):
    if not os.path.isdir(app_root) or os.path.islink(app_root):
        fail("INVENTORY_WRITER_GUARD_CHECKOUT_INVALID", "app root")
    head = git(app_root, "rev-parse", "HEAD")
    if head not in expected_commits:
        fail("INVENTORY_WRITER_GUARD_COMMIT_MISMATCH", f"expected={','.join(sorted(expected_commits))}:actual={head}")
    dirty = [row for row in git(app_root, "status", "--porcelain=v1", "-z", "--untracked-files=all", binary=True).split(b"\0") if row]
    index = [row.decode("utf-8") for row in git(app_root, "ls-files", "-v", "-z", binary=True).split(b"\0") if row]
    hidden = [row[2:] for row in index if row.startswith("S ") or (len(row) > 1 and row[0].islower() and row[1] == " ")]
    tracked = [row.decode("utf-8") for row in git(app_root, "ls-files", "-z", binary=True).split(b"\0") if row]
    missing = [row for row in tracked if not os.path.lexists(os.path.join(app_root, row))]
    if dirty or hidden or missing:
        fail("INVENTORY_WRITER_GUARD_CHECKOUT_NOT_CLEAN", f"dirty={len(dirty)}:hidden={len(hidden)}:missing={len(missing)}")
    permission = validate_source_permissions(app_root, tracked, service_uid)
    return (head, permission) if return_scope else head


def run(args):
    executable_path = validate_guard_executable(args)
    validate_execstartpre_last(args, executable_path)
    service_uid = resolve_service_uid(args.service_group)
    activation_exists = os.path.lexists(args.activation_file)
    receipt_exists = os.path.lexists(args.activation_receipt_file)
    if not activation_exists and not receipt_exists:
        if os.path.lexists(args.compatibility_file) or os.path.lexists(args.compatibility_receipt_file):
            fail("INVENTORY_WRITER_GUARD_COMPATIBILITY_INVALID", "compatibility state without activation")
        return {"ok": True, "activated": False, "state": "pre_activation_compatible"}
    if not activation_exists or not receipt_exists:
        fail("INVENTORY_WRITER_GUARD_ACTIVATION_INCOMPLETE", "activation and receipt must both exist")
    registry_bytes = read_bytes(args.activation_file, 1024 * 1024, "activation registry", args.filesystem_trust_root)
    lines = [line for line in registry_bytes.decode("utf-8").splitlines() if line.strip()]
    if len(lines) != 1:
        fail("INVENTORY_WRITER_GUARD_SCHEMA_INVALID", "activation registry line count")
    activation = parse_json(lines[0].encode("utf-8"), "activation registry")
    validate_activation(activation)
    receipt = parse_json(read_bytes(args.activation_receipt_file, 64 * 1024, "activation receipt", args.filesystem_trust_root), "activation receipt")
    validate_receipt(receipt, args.activation_file, hashlib.sha256(registry_bytes).hexdigest(), activation["activationHash"])
    compatibility_bytes = read_bytes(args.compatibility_file, 1024 * 1024, "compatibility registry", args.filesystem_trust_root)
    compatibility = validate_compatibility_registry(compatibility_bytes, activation)
    compatibility_receipt = parse_json(
        read_bytes(args.compatibility_receipt_file, 64 * 1024, "compatibility receipt", args.filesystem_trust_root),
        "compatibility receipt",
    )
    validate_compatibility_receipt(
        compatibility_receipt, args.compatibility_file,
        hashlib.sha256(compatibility_bytes).hexdigest(), compatibility,
    )
    active_commit = compatibility["active"]["authority"]["deployedCommit"]
    staged_commit = compatibility["pending"]["candidateAuthority"]["deployedCommit"] if compatibility["pending"] else None
    allowed = {active_commit} | ({staged_commit} if staged_commit else set())
    head, permission = validate_checkout(
        os.path.abspath(args.app_root), allowed, return_scope=True, service_uid=service_uid)
    state = "rotation_candidate_staged" if staged_commit and head == staged_commit and head != active_commit else "activated_exact"
    return {
        "ok": True, "activated": True, "state": state, "deployedCommit": head,
        "activationHash": activation["activationHash"], "activeGeneration": compatibility["active"]["generation"],
        "pendingGeneration": compatibility["pending"]["generation"] if compatibility["pending"] else None,
        "currentSourceGeneration": current_source_generation(permission, head),
        "managedSource": {
            "pathCount": len(permission["managedSourcePaths"]),
            "paths": permission["managedSourcePaths"],
        },
        "managedRuntime": {
            "roots": [row["name"] for row in permission["managedRuntimeRoots"]],
            "pathCount": len(permission["managedRuntimeRoots"]),
        },
        "excludedRuntimeRoots": permission["excludedRuntimeRoots"],
        "externalRuntimeMounts": permission["externalRuntimeMounts"],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--unit", required=True)
    parser.add_argument("--systemctl-bin", default="/usr/bin/systemctl")
    parser.add_argument("--app-root", default=DEFAULT_APP_ROOT)
    parser.add_argument("--activation-file", default=DEFAULT_ACTIVATION)
    parser.add_argument("--activation-receipt-file", default=DEFAULT_RECEIPT)
    parser.add_argument("--compatibility-file", default=DEFAULT_COMPATIBILITY)
    parser.add_argument("--compatibility-receipt-file", default=DEFAULT_COMPATIBILITY_RECEIPT)
    parser.add_argument("--service-group", default=DEFAULT_SERVICE_GROUP)
    parser.add_argument("--filesystem-trust-root", default="/")
    args = parser.parse_args()
    try:
        executable_path = validate_guard_executable(args)
        if reexec_in_host_mount_namespace(executable_path):
            return 0
        result = run(args)
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except GuardError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 78
    except Exception as error:  # Never turn an unexpected reader failure into admission.
        print(json.dumps({"ok": False, "code": "INVENTORY_WRITER_GUARD_INTERNAL_ERROR", "message": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 78


if __name__ == "__main__":
    raise SystemExit(main())
