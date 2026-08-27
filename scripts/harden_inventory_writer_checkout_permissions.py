#!/usr/bin/python3
"""Root-controlled, exact-path source hardening for inventory writer checkouts.

The checkout is the only permission-managed source of authority. Runtime
mounts are classified once into a frozen plan; external mounts and everything
under them are evidence only and are never permission mutation targets.
"""

import argparse
import array
import datetime
import grp
import hashlib
import json
import os
import pwd
import re
import socket
import stat
import subprocess
import sys

APPLY_CONFIRM = "HARDEN_INVENTORY_WRITER_CHECKOUT_V1"
ROLLBACK_CONFIRM = "ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1"
SCHEMA = "inventory-writer-checkout-permissions/v1"
LEGACY_PLAN_SCHEMA = "inventory-writer-checkout-permissions-plan/v1"
PLAN_SCHEMA = "inventory-writer-checkout-permissions-plan/v2"
LEGACY_COMPLETION_SCHEMA = "inventory-writer-checkout-permissions-completion/v2"
COMPLETION_SCHEMA = "inventory-writer-checkout-permissions-completion/v3"
DEFAULT_SERVICE_GROUP = "sheinops"
ALLOWLIST = ("state", "tmp", "outputs", "profiles", "node_modules")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX_COMMIT = re.compile(r"^(?:[0-9a-f]{40}|[0-9a-f]{64})$")
GENERATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
MAJOR_MINOR = re.compile(r"^\d+:\d+$")
RECOVERY_FD_SHARD_SIZE = 256
_RESOLVED_SERVICE_UID = 0


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


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


def file_sha256(file):
    with open(file, "rb") as stream:
        return hashlib.sha256(stream.read()).hexdigest()


def git(app, *args):
    result = subprocess.run(
        ["git", "-c", f"safe.directory={app}", *args], cwd=app,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    if result.returncode:
        raise RuntimeError(f"git failed:{args}:{result.returncode}")
    return result.stdout


def tracked(app):
    return [row.decode("utf-8") for row in git(app, "ls-files", "-z").split(b"\0") if row]


def path_type(info):
    if stat.S_ISDIR(info.st_mode): return "directory"
    if stat.S_ISREG(info.st_mode): return "file"
    if stat.S_ISLNK(info.st_mode): return "symlink"
    return "other"


def is_under(root, target):
    root = os.path.normpath(os.path.abspath(root))
    target = os.path.normpath(os.path.abspath(target))
    try:
        return os.path.commonpath([root, target]) == root
    except ValueError:
        return False


def ensure_no_symlink_components(app, target):
    app = os.path.normpath(os.path.abspath(app))
    target = os.path.normpath(os.path.abspath(target))
    if not is_under(app, target):
        raise RuntimeError(f"path outside app root:{target}")
    current = app
    info = os.lstat(current)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"app root path unsafe:{app}")
    relative = os.path.relpath(target, app)
    if relative == ".":
        return
    components = relative.split(os.sep)
    for index, component in enumerate(components):
        if component in ("", ".", ".."):
            raise RuntimeError(f"path component invalid:{target}")
        current = os.path.join(current, component)
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"symlink path component:{current}")
        if index < len(components) - 1 and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f"non-directory path component:{current}")


def ensure_no_symlink_parent(target):
    target = os.path.normpath(os.path.abspath(target))
    current = os.path.dirname(target)
    missing = []
    while current and not os.path.lexists(current):
        missing.append(current)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    while current:
        info = os.lstat(current)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f"artifact parent path unsafe:{current}")
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return missing


def decode_mountinfo_field(value):
    def decode(match):
        return chr(int(match.group(1), 8))

    return re.sub(r"\\([0-7]{3})", decode, value)


def mountinfo_entries():
    try:
        stream = open("/proc/self/mountinfo", "r", encoding="utf-8")
    except OSError as error:
        raise RuntimeError(f"mount inventory unavailable:{error}") from error
    entries = []
    with stream:
        for line in stream:
            head, separator, tail = line.rstrip("\n").partition(" - ")
            if not separator:
                raise RuntimeError("mount inventory row malformed")
            fields = head.split()
            post_fields = tail.split()
            if len(fields) < 6 or len(post_fields) < 3 or not fields[0].isdigit():
                raise RuntimeError("mount inventory row incomplete")
            mount_options = fields[5].split(",")
            super_options = post_fields[2].split(",")
            identity = {
                "mountId": int(fields[0]),
                "mountpoint": os.path.normpath(decode_mountinfo_field(fields[4])),
                "root": decode_mountinfo_field(fields[3]),
                "majorMinor": fields[2],
                "roRw": "ro" if "ro" in mount_options or "ro" in super_options else "rw",
            }
            validate_mount_identity(identity)
            entries.append(identity)
    return entries


def mount_identity(entry):
    return {
        "mountId": entry["mountId"],
        "mountpoint": entry["mountpoint"],
        "root": entry["root"],
        "majorMinor": entry["majorMinor"],
        "roRw": entry["roRw"],
    }


def fresh_mount_identities(app):
    return sorted(
        [mount_identity(entry) for entry in mountinfo_entries() if is_under(app, entry["mountpoint"])],
        key=lambda row: (row["mountpoint"], row["mountId"]),
    )


def source_paths(app):
    values = {app}
    git_dir = os.path.join(app, ".git")
    git_info = os.lstat(git_dir)
    if not stat.S_ISDIR(git_info.st_mode) or stat.S_ISLNK(git_info.st_mode):
        raise RuntimeError(".git must be a real directory")
    def walk_error(error):
        raise RuntimeError(f"source authority walk failed:{error}") from error

    for current, directories, files in os.walk(git_dir, followlinks=False, onerror=walk_error):
        values.add(current)
        values.update(os.path.join(current, name) for name in directories + files)
    for relative in tracked(app):
        current = os.path.join(app, relative)
        if not os.path.lexists(current):
            raise RuntimeError(f"tracked path missing:{relative}")
        values.add(current)
        current = os.path.dirname(current)
        while current != app:
            values.add(current)
            current = os.path.dirname(current)
    result = sorted(values)
    for target in result:
        ensure_no_symlink_components(app, target)
    return result


def runtime_root_scope(app, app_info, source, mount_entries):
    source_set = set(source)
    git_dir = os.path.join(app, ".git")
    mounts = []
    for entry in mount_entries:
        mountpoint = entry["mountpoint"]
        if not is_under(app, mountpoint):
            continue
        if mountpoint == app:
            raise RuntimeError("app root mount is outside runtime allowlist")
        relative = os.path.relpath(mountpoint, app).replace(os.sep, "/")
        first = relative.split("/", 1)[0]
        exact_runtime_root = relative in ALLOWLIST
        if is_under(git_dir, mountpoint):
            raise RuntimeError(f"mount under source authority:{mountpoint}")
        if first not in ALLOWLIST:
            if mountpoint in source_set:
                raise RuntimeError(f"mount under source authority:{mountpoint}")
            raise RuntimeError(f"external mount outside runtime allowlist:{mountpoint}")
        if mountpoint in source_set and not exact_runtime_root:
            raise RuntimeError(f"mount under source authority:{mountpoint}")
        hidden_source = [path for path in source if path != mountpoint and is_under(mountpoint, path)]
        if hidden_source:
            raise RuntimeError(f"mount hides tracked source:{mountpoint}")
        mounts.append(mount_identity(entry))
    if len({row["mountpoint"] for row in mounts}) != len(mounts):
        raise RuntimeError("ambiguous external mount identity")
    mounts.sort(key=lambda row: (row["mountpoint"], row["mountId"]))

    records = []
    for name in ALLOWLIST:
        target = os.path.join(app, name)
        ensure_no_symlink_components(app, target)
        info = os.lstat(target)
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError(f"runtime allowlist root must be a real directory or bind mount:{name}")
        exact_mounts = [row for row in mounts if row["mountpoint"] == target]
        if len(exact_mounts) > 1:
            raise RuntimeError(f"ambiguous runtime root mount identity:{name}")
        different_device = info.st_dev != app_info.st_dev
        if different_device and not exact_mounts:
            raise RuntimeError(f"runtime mount identity unavailable:{name}")
        read_only_mode = not stat.S_IMODE(info.st_mode) & 0o222
        hidden_source = [path for path in source if path != target and is_under(target, path)]
        if read_only_mode and hidden_source:
            raise RuntimeError(f"read-only runtime root hides tracked source:{name}")
        external = bool(exact_mounts or different_device)
        reasons = []
        if external:
            reasons.append("external-mount")
        if read_only_mode:
            reasons.append("read-only-mode")
        records.append({
            "name": name,
            "path": target,
            "excluded": bool(reasons),
            "external": external,
            "reasons": reasons,
            "mountIdentity": exact_mounts[0] if exact_mounts else None,
        })
    return records, mounts


def validate_external_parent_chain(app, service_uid=None):
    """Prove that a non-root writer cannot rename the checkout from outside.

    The hardener runs as root, but the writer does not.  A root-owned,
    non-group/world-writable parent is the normal case.  A sticky directory
    such as /tmp is accepted only when the checkout entry is already
    root-owned; otherwise the writer can still rename its own entry.  An
    unresolved service identity is represented by uid 0 and retains the
    previous root-only owner policy.  Once a non-root writer is known, a
    non-writable parent owned by another user is safe, while a parent owned
    by the writer is rejected when its owner-write bit is set.  This is a
    pathname precondition only.  The mutation path also holds directory fds,
    removes in-tree rename rights, and rechecks the fd-to-path identity before
    every possible write.  A concurrent root attacker is explicitly outside
    this model because root can bypass both permission and fd-path checks
    between the final check and a syscall.
    """
    if service_uid is None:
        service_uid = _RESOLVED_SERVICE_UID
    child = app
    current = os.path.dirname(app)
    while True:
        try:
            parent_info = os.lstat(current)
            child_info = os.lstat(child)
        except OSError as error:
            raise RuntimeError(f"external parent chain unreadable:{current}:{error.errno}") from error
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode) \
                or not stat.S_ISDIR(child_info.st_mode) or stat.S_ISLNK(child_info.st_mode):
            raise RuntimeError(f"external parent chain unsafe:{current}")
        # An unresolved service identity is represented by uid 0 and keeps the
        # previous root-only owner policy.  Once a non-root writer is known,
        # ownership by another non-writable user is safe and ownership by the
        # writer is rejected only when its owner-write bit is set.
        if current != "/" and service_uid == 0 and parent_info.st_uid != 0:
            raise RuntimeError(f"external parent must be root-owned:{current}")
        parent_mode = stat.S_IMODE(parent_info.st_mode)
        if parent_mode & 0o022 and not (parent_mode & stat.S_ISVTX and child_info.st_uid == 0):
            raise RuntimeError(f"external parent permits service rename:{current}")
        if service_uid != 0 and parent_info.st_uid == service_uid and parent_mode & 0o200:
            raise RuntimeError(f"external parent permits service rename:{current}")
        if current == os.path.dirname(current):
            return
        child = current
        current = os.path.dirname(current)


def build_scope(app, service_uid=None):
    app = os.path.normpath(os.path.abspath(app))
    app_info = os.lstat(app)
    if not stat.S_ISDIR(app_info.st_mode) or stat.S_ISLNK(app_info.st_mode):
        raise RuntimeError("app root must be a real directory")
    validate_external_parent_chain(app, service_uid)
    source_authority = source_paths(app)
    runtime, external_mounts = runtime_root_scope(app, app_info, source_authority, mountinfo_entries())
    runtime_paths = {row["path"] for row in runtime}
    managed_runtime = [row for row in runtime if not row["excluded"]]
    excluded_runtime = [row for row in runtime if row["excluded"]]
    managed_source = [path for path in source_authority if path not in runtime_paths]
    managed = sorted(set(managed_source + [row["path"] for row in managed_runtime]))
    return {
        "appRoot": app,
        "sourceAuthorityPaths": source_authority,
        "managedSourcePaths": managed_source,
        "managedRuntimeRoots": managed_runtime,
        "excludedRuntimeRoots": excluded_runtime,
        "externalRuntimeMounts": external_mounts,
        "managedPaths": managed,
    }


def source_generation(scope, generation_id):
    if not isinstance(generation_id, str) or not GENERATION_ID.fullmatch(generation_id):
        raise RuntimeError("source generation id invalid")
    head = git(scope["appRoot"], "rev-parse", "HEAD").decode("ascii").strip()
    if not HEX_COMMIT.fullmatch(head):
        raise RuntimeError("source generation commit invalid")
    fingerprint = {
        "headCommit": head,
        "managedSourcePathCount": len(scope["managedSourcePaths"]),
        "managedSourcePathsSha256": digest(scope["managedSourcePaths"]),
        "managedRuntimeRootsSha256": digest([
            {"name": row["name"], "path": row["path"]} for row in scope["managedRuntimeRoots"]
        ]),
        "externalRuntimeMountsSha256": digest(scope["externalRuntimeMounts"]),
    }
    return {"generationId": generation_id, **fingerprint, "generationHash": digest(fingerprint)}


def validate_source_generation(value, managed_source_paths=None, managed_runtime_roots=None,
                               external_runtime_mounts=None):
    keys = {
        "generationId", "headCommit", "managedSourcePathCount", "managedSourcePathsSha256",
        "managedRuntimeRootsSha256", "externalRuntimeMountsSha256", "generationHash",
    }
    if not isinstance(value, dict) or set(value) != keys \
            or not isinstance(value["generationId"], str) or not GENERATION_ID.fullmatch(value["generationId"]) \
            or not isinstance(value["headCommit"], str) or not HEX_COMMIT.fullmatch(value["headCommit"]) \
            or not isinstance(value["managedSourcePathCount"], int) \
            or isinstance(value["managedSourcePathCount"], bool) or value["managedSourcePathCount"] < 1:
        raise RuntimeError("source generation invalid")
    for key in ("managedSourcePathsSha256", "managedRuntimeRootsSha256", "externalRuntimeMountsSha256", "generationHash"):
        if not isinstance(value[key], str) or not HEX64.fullmatch(value[key]):
            raise RuntimeError("source generation hash invalid")
    fingerprint = {key: value[key] for key in (
        "headCommit", "managedSourcePathCount", "managedSourcePathsSha256",
        "managedRuntimeRootsSha256", "externalRuntimeMountsSha256",
    )}
    if value["generationHash"] != digest(fingerprint):
        raise RuntimeError("source generation fingerprint invalid")
    if managed_source_paths is not None:
        if value["managedSourcePathCount"] != len(managed_source_paths) \
                or value["managedSourcePathsSha256"] != digest(managed_source_paths):
            raise RuntimeError("source generation managed source binding invalid")
    if managed_runtime_roots is not None:
        roots = [{"name": row["name"], "path": row["path"]} for row in managed_runtime_roots]
        if value["managedRuntimeRootsSha256"] != digest(roots):
            raise RuntimeError("source generation runtime binding invalid")
    if external_runtime_mounts is not None \
            and value["externalRuntimeMountsSha256"] != digest(external_runtime_mounts):
        raise RuntimeError("source generation mount binding invalid")
    return value


def validate_fresh_scope(scope):
    observed_mounts = fresh_mount_identities(scope["appRoot"])
    if observed_mounts != scope["externalRuntimeMounts"]:
        raise RuntimeError("external runtime mount identity drift")
    app_info = os.lstat(scope["appRoot"])
    for row in scope["managedRuntimeRoots"] + scope["excludedRuntimeRoots"]:
        info = os.lstat(row["path"])
        exact = [mount for mount in observed_mounts if mount["mountpoint"] == row["path"]]
        if row["mountIdentity"] != (exact[0] if exact else None):
            raise RuntimeError(f"runtime mount identity drift:{row['name']}")
        observed_external = bool(exact or info.st_dev != app_info.st_dev)
        if observed_external != row["external"]:
            raise RuntimeError(f"runtime device identity drift:{row['name']}")
        read_only = not stat.S_IMODE(info.st_mode) & 0o222
        if read_only != ("read-only-mode" in row["reasons"]):
            raise RuntimeError(f"runtime read-only state drift:{row['name']}")


def inventory_paths(app, service_uid=None):
    return build_scope(app, service_uid)["managedPaths"]


def snapshot_paths(paths):
    rows = []
    for target in sorted(paths):
        info = os.lstat(target)
        rows.append({
            "path": target, "type": path_type(info), "uid": info.st_uid, "gid": info.st_gid,
            "mode": stat.S_IMODE(info.st_mode), "st_dev": info.st_dev,
            "st_ino": info.st_ino, "st_nlink": info.st_nlink,
        })
    return rows


METADATA_ROW_KEYS = {"path", "type", "uid", "gid", "mode"}
IDENTITY_ROW_KEYS = METADATA_ROW_KEYS | {"st_dev", "st_ino", "st_nlink"}


def metadata_row(row):
    return {key: row[key] for key in ("path", "type", "uid", "gid", "mode")}


def validate_identity_row(row, app, label="permission plan row"):
    if not isinstance(row, dict) or set(row) != IDENTITY_ROW_KEYS:
        raise RuntimeError(f"{label} schema invalid")
    path = row["path"]
    if not isinstance(path, str) or os.path.abspath(path) != path \
            or os.path.normpath(path) != path or not is_under(app, path):
        raise RuntimeError(f"{label} path invalid")
    if row["type"] not in ("directory", "file"):
        raise RuntimeError(f"{label} type invalid:{path}")
    for key in ("uid", "gid", "mode", "st_dev", "st_ino", "st_nlink"):
        value = row[key]
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise RuntimeError(f"{label} identity invalid:{path}:{key}")
    if row["mode"] > 0o7777 or row["st_ino"] < 1 or row["st_nlink"] < 1:
        raise RuntimeError(f"{label} identity invalid:{path}")
    if row["type"] == "file" and row["st_nlink"] != 1:
        raise RuntimeError(f"{label} regular file link count invalid:{path}")
    return row


def snapshot(app, service_uid=None):
    return snapshot_paths(inventory_paths(app, service_uid))


def write_atomic_no_replace(file, value):
    parent = os.path.dirname(file) or "."
    os.makedirs(parent, exist_ok=True)
    temporary = f"{file}.tmp-{os.getpid()}"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(canonical(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    try:
        os.link(temporary, file)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    directory = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def desired_mode(app, target, info):
    relative = os.path.relpath(target, app).replace(os.sep, "/")
    if target == app: return 0o750
    if relative in ALLOWLIST: return 0o1770
    if stat.S_ISDIR(info.st_mode): return 0o750
    if stat.S_ISREG(info.st_mode): return 0o750 if info.st_mode & 0o111 else 0o640
    raise RuntimeError(f"unsupported source path type:{target}")


def desired_mode_from_row(app, row):
    if row["path"] == app: return 0o750
    relative = os.path.relpath(row["path"], app).replace(os.sep, "/")
    if relative in ALLOWLIST: return 0o1770
    if row["type"] == "directory": return 0o750
    if row["type"] == "file": return 0o750 if row["mode"] & 0o111 else 0o640
    raise RuntimeError(f"unsupported source path type:{row['path']}")


def validate_mount_identity(row):
    if not isinstance(row, dict) or set(row) != {"mountId", "mountpoint", "root", "majorMinor", "roRw"} \
            or not isinstance(row["mountId"], int) or isinstance(row["mountId"], bool) or row["mountId"] < 1 \
            or not isinstance(row["mountpoint"], str) or not os.path.isabs(row["mountpoint"]) \
            or os.path.normpath(row["mountpoint"]) != row["mountpoint"] \
            or not isinstance(row["root"], str) or not row["root"].startswith("/") \
            or not isinstance(row["majorMinor"], str) or not MAJOR_MINOR.fullmatch(row["majorMinor"]) \
            or row["roRw"] not in ("ro", "rw"):
        raise RuntimeError("external runtime mount identity invalid")


def validate_mount_identities(mounts):
    if not isinstance(mounts, list):
        raise RuntimeError("external runtime mount manifest invalid")
    previous = ("", -1)
    for row in mounts:
        validate_mount_identity(row)
        ordering = (row["mountpoint"], row["mountId"])
        if ordering <= previous:
            raise RuntimeError("external runtime mount identity ordering invalid")
        previous = ordering


def validate_receipt(receipt, app, gid):
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != SCHEMA \
            or receipt.get("kind") != "inventory_writer_checkout_permissions":
        raise RuntimeError("permission receipt schema invalid")
    if receipt.get("appRoot") != app or receipt.get("serviceGid") != gid:
        raise RuntimeError("permission receipt binding invalid")
    before = receipt.get("before")
    if not isinstance(before, list) or not before:
        raise RuntimeError("permission receipt before manifest invalid")
    if receipt.get("beforeManifestSha256") != digest(before):
        raise RuntimeError("permission receipt before manifest hash invalid")
    paths = []
    identity_manifest = None
    for row in before:
        if not isinstance(row, dict) or set(row) not in (METADATA_ROW_KEYS, IDENTITY_ROW_KEYS):
            raise RuntimeError("permission receipt before row invalid")
        row_has_identity = set(row) == IDENTITY_ROW_KEYS
        if identity_manifest is None:
            identity_manifest = row_has_identity
        elif identity_manifest is not row_has_identity:
            raise RuntimeError("permission receipt before identity manifest mixed")
        path = row["path"]
        if not isinstance(path, str) or os.path.abspath(path) != path or os.path.normpath(path) != path:
            raise RuntimeError("permission receipt path invalid")
        if not is_under(app, path) or path in paths:
            raise RuntimeError("permission receipt path binding invalid")
        if row["type"] not in ("directory", "file", "symlink", "other"):
            raise RuntimeError("permission receipt path type invalid")
        if not isinstance(row["uid"], int) or isinstance(row["uid"], bool) or row["uid"] < 0 \
                or not isinstance(row["gid"], int) or isinstance(row["gid"], bool) or row["gid"] < 0 \
                or not isinstance(row["mode"], int) or isinstance(row["mode"], bool) \
                or row["mode"] < 0 or row["mode"] > 0o7777:
            raise RuntimeError("permission receipt metadata invalid")
        if row_has_identity:
            validate_identity_row(row, app, "permission receipt before row")
        paths.append(path)
    declared = receipt.get("managedPaths")
    if declared is not None:
        if not isinstance(declared, list) or any(not isinstance(path, str) for path in declared) \
                or declared != sorted(set(declared)) or set(declared) != set(paths):
            raise RuntimeError("permission receipt managed path scope invalid")
    external = receipt.get("externalRuntimeMounts")
    if external is not None:
        validate_mount_identities(external)
    plan_sha = receipt.get("planSha256")
    if plan_sha is not None and (not isinstance(plan_sha, str) or not HEX64.fullmatch(plan_sha)):
        raise RuntimeError("permission receipt plan hash invalid")
    generation = receipt.get("sourceGeneration")
    if generation is not None:
        validate_source_generation(generation)
    return receipt


def receipt_rows_for_scope(receipt, scope):
    current_managed = set(scope["managedPaths"])
    current_excluded = {row["path"] for row in scope["excludedRuntimeRoots"]}
    selected = []
    for row in receipt["before"]:
        path = row["path"]
        if path in current_excluded:
            continue
        if any(is_under(root, path) and path != root for root in current_excluded):
            raise RuntimeError(f"permission receipt path inside excluded runtime root:{path}")
        if path not in current_managed:
            raise RuntimeError(f"permission receipt managed path drift:{path}")
        selected.append(row)
    if {row["path"] for row in selected} != current_managed:
        raise RuntimeError("permission receipt managed path scope incomplete")
    return selected


def plan_payload(scope, gid, rows, generation, schema=PLAN_SCHEMA):
    validate_source_generation(
        generation, scope["managedSourcePaths"], scope["managedRuntimeRoots"],
        scope["externalRuntimeMounts"],
    )
    if schema == PLAN_SCHEMA:
        if not isinstance(rows, list) or not rows:
            raise RuntimeError("permission plan managed rows invalid")
        seen = set()
        for row in rows:
            validate_identity_row(row, scope["appRoot"])
            if row["path"] in seen:
                raise RuntimeError("permission plan managed path duplicate")
            seen.add(row["path"])
        if seen != set(scope["managedPaths"]):
            raise RuntimeError("permission plan managed path scope invalid")
    elif schema != LEGACY_PLAN_SCHEMA:
        raise RuntimeError("permission plan schema invalid")
    return {
        "schemaVersion": schema,
        "kind": "inventory_writer_checkout_permissions_plan",
        "appRoot": scope["appRoot"],
        "serviceGid": gid,
        "sourceGeneration": generation,
        "managedSourcePaths": scope["managedSourcePaths"],
        "managedRuntimeRoots": scope["managedRuntimeRoots"],
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
        "managedBefore": rows,
    }


def plan_hash(payload):
    return digest(payload)


def load_plan_file(file, expected_hash=""):
    info = os.lstat(file)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise RuntimeError("permission plan must be a regular file")
    descriptor = os.open(file, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if opened.st_dev != info.st_dev or opened.st_ino != info.st_ino \
                or opened.st_nlink != 1 or not stat.S_ISREG(opened.st_mode):
            raise RuntimeError("permission plan file identity drift")
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            value = json.loads(stream.read())
    finally:
        os.close(descriptor)
    expected_keys = {
        "schemaVersion", "kind", "appRoot", "serviceGid", "sourceGeneration",
        "managedSourcePaths", "managedRuntimeRoots", "excludedRuntimeRoots",
        "externalRuntimeMounts", "managedBefore", "planHash",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise RuntimeError("permission plan schema invalid")
    core = {key: value[key] for key in value if key != "planHash"}
    if value.get("planHash") != digest(core) or value.get("schemaVersion") != PLAN_SCHEMA:
        raise RuntimeError("permission plan drift")
    if expected_hash and value["planHash"] != expected_hash:
        raise RuntimeError("permission plan SHA-256 mismatch")
    if value.get("kind") != "inventory_writer_checkout_permissions_plan":
        raise RuntimeError("permission plan kind invalid")
    if not isinstance(value.get("managedBefore"), list) or not value["managedBefore"]:
        raise RuntimeError("permission plan managed rows invalid")
    seen = set()
    for row in value["managedBefore"]:
        validate_identity_row(row, value.get("appRoot", ""))
        if row["path"] in seen:
            raise RuntimeError("permission plan managed path duplicate")
        seen.add(row["path"])
    return value, core


def validate_plan_file(file, expected_hash, payload):
    if payload.get("schemaVersion") == LEGACY_PLAN_SCHEMA:
        info = os.lstat(file)
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("legacy permission plan must be a regular file")
        value = json.loads(open(file, "rb").read())
        if not isinstance(value, dict) or set(value) != set(payload) | {"planHash"}:
            raise RuntimeError("legacy permission plan schema invalid")
        core = {key: value[key] for key in value if key != "planHash"}
        if value.get("planHash") != digest(core) or value["planHash"] != expected_hash or core != payload:
            raise RuntimeError("legacy permission plan drift")
        return value
    value, core = load_plan_file(file, expected_hash)
    if core != payload:
        raise RuntimeError("permission plan drift")
    return value


def generation_for_receipt(receipt, scope):
    recorded = receipt.get("sourceGeneration")
    if recorded is None:
        generation_id = f"legacy-receipt:{receipt['receiptHash'][:16]}"
    else:
        generation_id = recorded["generationId"]
    current = source_generation(scope, generation_id)
    if recorded is not None and current != recorded:
        raise RuntimeError("permission receipt source generation drift")
    return current


def validate_exact_source_clean(app):
    dirty = [row for row in git(app, "status", "--porcelain=v1", "-z", "--untracked-files=all").split(b"\0") if row]
    index = [row.decode("utf-8") for row in git(app, "ls-files", "-v", "-z").split(b"\0") if row]
    hidden = [row[2:] for row in index if row.startswith("S ")
              or (len(row) > 1 and row[0].islower() and row[1] == " ")]
    tracked_paths = [row.decode("utf-8") for row in git(app, "ls-files", "-z").split(b"\0") if row]
    missing = [relative for relative in tracked_paths if not os.path.lexists(os.path.join(app, relative))]
    if dirty or hidden or missing:
        raise RuntimeError(
            f"exact source checkout not clean:dirty={len(dirty)}:hidden={len(hidden)}:missing={len(missing)}")


def legal_permission_states(row, app, gid, operation):
    desired = desired_mode_from_row(app, row)
    before = (row["uid"], row["gid"], row["mode"])
    legal = {before, (0, gid, row["mode"]), (0, gid, desired)}
    if row["type"] == "directory":
        legal.add((0, gid, row["mode"] & ~0o022))
        legal.add((0, gid, desired & ~0o022))
    if operation in ("rollback", "recovery"):
        legal |= {
            (row["uid"], gid, row["mode"]),
            (row["uid"], gid, desired),
            (row["uid"], row["gid"], desired),
        }
    return legal


def state_tuple(info):
    return info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)


def identity_from_info(info):
    return {
        "type": path_type(info), "st_dev": info.st_dev, "st_ino": info.st_ino,
        "st_nlink": info.st_nlink,
    }


def verify_opened_identity(descriptor, expected, target, expected_type=None):
    info = os.fstat(descriptor)
    observed_type = path_type(info)
    if expected_type is not None and observed_type != expected_type:
        raise RuntimeError(f"opened permission path type drift:{target}")
    if observed_type != expected["type"] or info.st_dev != expected["st_dev"] \
            or info.st_ino != expected["st_ino"] or info.st_nlink != expected["st_nlink"]:
        raise RuntimeError(
            f"opened permission path identity drift:{target}:"
            f"expected={expected['type']},{expected['st_dev']},{expected['st_ino']},{expected['st_nlink']}:"
            f"actual={observed_type},{info.st_dev},{info.st_ino},{info.st_nlink}")
    if observed_type == "file" and info.st_nlink != 1:
        raise RuntimeError(f"opened permission regular file link count drift:{target}")
    return info


def verify_path_identity(expected, target):
    try:
        info = os.lstat(target)
    except OSError as error:
        raise RuntimeError(f"permission path identity unavailable:{target}:{error.errno}") from error
    observed = identity_from_info(info)
    expected_identity = {key: expected[key] for key in ("type", "st_dev", "st_ino", "st_nlink")}
    if observed != expected_identity:
        raise RuntimeError(
            f"permission path identity drift:{target}:"
            f"expected={expected_identity}:actual={observed}")
    if observed["type"] not in ("directory", "file"):
        raise RuntimeError(f"permission path type drift:{target}")
    return info


def directory_chain(app, target, include_target=False):
    current = target if include_target else os.path.dirname(target)
    if target == app and not include_target:
        return []
    chain = []
    while True:
        if not is_under(app, current):
            raise RuntimeError(f"permission path escaped app root:{target}")
        chain.append(current)
        if current == app:
            return list(reversed(chain))
        parent = os.path.dirname(current)
        if parent == current:
            raise RuntimeError(f"permission app ancestor not reached:{target}")
        current = parent


def verify_locked_ancestors(app, target, validated, directory_fds, gid, service_uid=None):
    validate_external_parent_chain(app, service_uid)
    for current in directory_chain(app, target, include_target=False):
        row = validated.get(current)
        descriptor = directory_fds.get(current)
        if row is None or row["type"] != "directory" or descriptor is None:
            raise RuntimeError(f"permission ancestor missing from locked scope:{current}")
        info = verify_opened_identity(descriptor, row, current, "directory")
        verify_path_identity(row, current)
        if info.st_uid != 0 or info.st_gid != gid \
                or info.st_mode & 0o022:
            raise RuntimeError(f"permission ancestor is not locked:{current}")


def verify_trusted_path_hierarchy(app, target, expected, validated, service_uid=None):
    """Verify the current pathname still denotes the frozen app hierarchy."""
    validate_external_parent_chain(app, service_uid)
    for current in directory_chain(
            app, target, include_target=expected["type"] == "directory"):
        row = validated.get(current)
        if row is None or row["type"] != "directory":
            raise RuntimeError(f"permission ancestor missing from plan:{current}")
        verify_path_identity(row, current)
    return verify_path_identity(expected, target)


def verify_trusted_target(app, target, descriptor, validated, directory_fds, gid, service_uid=None):
    verify_locked_ancestors(app, target, validated, directory_fds, gid, service_uid)
    expected = validated[target]
    verify_path_identity(expected, target)
    return verify_opened_identity(descriptor, expected, target, expected["type"])


def validate_opened_state(info, row, app, gid, operation, target):
    if state_tuple(info) not in legal_permission_states(row, app, gid, operation):
        raise RuntimeError(f"permission state drift:{target}")


def open_untrusted_plan_target(app_descriptor, app, target, expected_type, captured):
    if target == app:
        return os.dup(app_descriptor)
    relative = os.path.relpath(target, app)
    components = relative.split(os.sep)
    if not components or any(component in ("", ".", "..") for component in components):
        raise RuntimeError(f"permission target component invalid:{target}")
    parent_descriptor = os.dup(app_descriptor)
    current = app
    try:
        for component in components[:-1]:
            current = os.path.join(current, component)
            if current not in captured or captured[current]["type"] != "directory":
                raise RuntimeError(f"permission parent absent from captured plan scope:{current}")
            child_descriptor = os.open(component, open_flags("directory"), dir_fd=parent_descriptor)
            try:
                verify_opened_identity(child_descriptor, captured[current], current, "directory")
            except Exception:
                os.close(child_descriptor)
                raise
            os.close(parent_descriptor)
            parent_descriptor = child_descriptor
        return os.open(components[-1], open_flags(expected_type), dir_fd=parent_descriptor)
    finally:
        os.close(parent_descriptor)


def capture_plan_rows(rows, app, gid, scope, operation="recovery"):
    excluded = {row["path"] for row in scope["excludedRuntimeRoots"]}
    by_path = {row["path"]: metadata_row(row) for row in rows if row["path"] not in excluded}
    expected_paths = set(scope["managedPaths"]) - excluded
    if set(by_path) != expected_paths or app not in by_path:
        raise RuntimeError("permission plan capture scope incomplete")
    captured = {}
    app_descriptor = os.open(app, open_flags("directory"))
    try:
        app_info = os.fstat(app_descriptor)
        if path_type(app_info) != by_path[app]["type"]:
            raise RuntimeError("permission plan app root type drift")
        validate_opened_state(app_info, by_path[app], app, gid, operation, app)
        captured[app] = {**by_path[app], **identity_from_info(app_info)}
        for target in sorted(expected_paths - {app}, key=lambda value: (value.count(os.sep), value)):
            row = by_path[target]
            if row["type"] not in ("directory", "file"):
                raise RuntimeError(f"unsupported source path type:{target}")
            descriptor = open_untrusted_plan_target(
                app_descriptor, app, target, row["type"], captured)
            try:
                info = os.fstat(descriptor)
                if path_type(info) != row["type"]:
                    raise RuntimeError(f"permission plan path type drift:{target}")
                if row["type"] == "file" and info.st_nlink != 1:
                    raise RuntimeError(f"permission plan regular file link count invalid:{target}")
                validate_opened_state(info, row, app, gid, operation, target)
                captured[target] = {**row, **identity_from_info(info)}
            finally:
                os.close(descriptor)
    finally:
        os.close(app_descriptor)
    return [captured[path] for path in sorted(captured)]


def validate_plan_binding(plan, scope, gid, generation, receipt_rows=None):
    expected = {
        "schemaVersion": PLAN_SCHEMA,
        "kind": "inventory_writer_checkout_permissions_plan",
        "appRoot": scope["appRoot"],
        "serviceGid": gid,
        "sourceGeneration": generation,
        "managedSourcePaths": scope["managedSourcePaths"],
        "managedRuntimeRoots": scope["managedRuntimeRoots"],
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
    }
    for key, value in expected.items():
        if plan.get(key) != value:
            raise RuntimeError(f"permission plan binding drift:{key}")
    rows = plan.get("managedBefore")
    if not isinstance(rows, list) or [row["path"] for row in rows] != sorted(scope["managedPaths"]):
        raise RuntimeError("permission plan managed scope drift")
    for row in rows:
        validate_identity_row(row, scope["appRoot"])
    if receipt_rows is not None:
        receipt_by_path = {row["path"]: row for row in receipt_rows}
        if set(receipt_by_path) != {row["path"] for row in rows}:
            raise RuntimeError("permission plan receipt scope drift")
        for row in rows:
            receipt_row = receipt_by_path[row["path"]]
            if metadata_row(row) != metadata_row(receipt_row):
                raise RuntimeError(f"permission plan receipt metadata drift:{row['path']}")
            if set(receipt_row) == IDENTITY_ROW_KEYS and row != receipt_row:
                raise RuntimeError(f"permission plan receipt identity drift:{row['path']}")
    return rows


def validate_current_rows(rows, app, gid, scope, operation, service_uid=None):
    validate_external_parent_chain(app, service_uid)
    excluded = {row["path"] for row in scope["excludedRuntimeRoots"]}
    validated = {row["path"]: row for row in rows if row["path"] not in excluded}
    if excluded & set(validated) or set(validated) != set(scope["managedPaths"]) - excluded:
        raise RuntimeError("permission validation scope drift")
    if app not in validated:
        raise RuntimeError("app root absent from validated mutation scope")
    app_descriptor = os.open(app, open_flags("directory"))
    try:
        info = verify_opened_identity(app_descriptor, validated[app], app, "directory")
        validate_opened_state(info, validated[app], app, gid, operation, app)
        for row in sorted(validated.values(), key=lambda value: (value["path"].count(os.sep), value["path"])):
            descriptor = open_anchored_target(
                app_descriptor, app, row["path"], row["type"], validated)
            try:
                info = verify_opened_identity(descriptor, row, row["path"], row["type"])
                validate_opened_state(info, row, app, gid, operation, row["path"])
            finally:
                os.close(descriptor)
    finally:
        os.close(app_descriptor)
    return validated


def open_flags(expected_type):
    base = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    if expected_type == "directory":
        return base | os.O_DIRECTORY
    if expected_type == "file":
        return base | getattr(os, "O_NONBLOCK", 0)
    raise RuntimeError(f"unsupported permission target type:{expected_type}")


def open_anchored_target(app_descriptor, app, target, expected_type, validated, directory_fds=None):
    directory_fds = directory_fds or {}
    if target in directory_fds:
        descriptor = os.dup(directory_fds[target])
        try:
            verify_opened_identity(descriptor, validated[target], target, expected_type)
            return descriptor
        except Exception:
            os.close(descriptor)
            raise
    if target == app:
        descriptor = os.dup(app_descriptor)
        try:
            verify_opened_identity(descriptor, validated[target], target, expected_type)
            return descriptor
        except Exception:
            os.close(descriptor)
            raise
    relative = os.path.relpath(target, app)
    components = relative.split(os.sep)
    if not components or any(component in ("", ".", "..") for component in components):
        raise RuntimeError(f"permission target component invalid:{target}")
    parent_descriptor = os.dup(app_descriptor)
    current = app
    try:
        for component in components[:-1]:
            current = os.path.join(current, component)
            if current not in validated or validated[current]["type"] != "directory":
                raise RuntimeError(f"permission parent absent from validated scope:{current}")
            child_descriptor = os.dup(directory_fds[current]) \
                if current in directory_fds else os.open(
                    component, open_flags("directory"), dir_fd=parent_descriptor)
            try:
                verify_opened_identity(child_descriptor, validated[current], current, "directory")
            except Exception:
                os.close(child_descriptor)
                raise
            os.close(parent_descriptor)
            parent_descriptor = child_descriptor
        descriptor = os.open(components[-1], open_flags(expected_type), dir_fd=parent_descriptor)
        try:
            verify_opened_identity(descriptor, validated[target], target, expected_type)
            return descriptor
        except Exception:
            os.close(descriptor)
            raise
    finally:
        os.close(parent_descriptor)


def desired_permission_state(app, gid, row, operation):
    if operation == "apply":
        return 0, gid, desired_mode_from_row(app, row)
    if operation == "rollback":
        return row["uid"], row["gid"], row["mode"]
    raise RuntimeError("permission mutation operation invalid")


def locked_directory_mode(info):
    return stat.S_IMODE(info.st_mode) & ~0o022


def mutate_fd_state(descriptor, row, desired_state, trust_check=None):
    """Mutate and read back one exact inode, optionally rechecking its path."""
    info = verify_opened_identity(descriptor, row, row["path"], row["type"])
    uid, gid, mode = desired_state
    if info.st_uid != uid or info.st_gid != gid:
        if trust_check is not None:
            trust_check()
        os.fchown(descriptor, uid, gid)
        info = verify_opened_identity(descriptor, row, row["path"], row["type"])
    if stat.S_IMODE(info.st_mode) != mode:
        if trust_check is not None:
            trust_check()
        os.fchmod(descriptor, mode)
    final = verify_opened_identity(descriptor, row, row["path"], row["type"])
    if state_tuple(final) != desired_state:
        raise RuntimeError(f"permission mutation readback failed:{row['path']}")
    return final


def restore_exact_record(record, recovery_pool=None):
    """Restore one exact inode through its already-held recovery fd only."""
    row = record["row"]
    descriptor = record["fd"]
    if descriptor is None:
        if recovery_pool is None:
            raise RuntimeError(f"exact-inode recovery fd unavailable:{row['path']}")
        recovery_pool.restore(record)
        return
    before = record["before"]
    verify_opened_identity(descriptor, row, row["path"], row["type"])
    current = os.fstat(descriptor)
    if current.st_uid != before[0] or current.st_gid != before[1]:
        os.fchown(descriptor, before[0], before[1])
    current = verify_opened_identity(descriptor, row, row["path"], row["type"])
    if stat.S_IMODE(current.st_mode) != before[2]:
        os.fchmod(descriptor, before[2])
    final = verify_opened_identity(descriptor, row, row["path"], row["type"])
    if state_tuple(final) != before:
        raise RuntimeError(f"exact-inode recovery readback failed:{row['path']}")


def _recovery_send(sock, payload, descriptor=None):
    data = canonical(payload)
    ancillary = []
    if descriptor is not None:
        values = array.array("i", [descriptor])
        ancillary.append((socket.SOL_SOCKET, socket.SCM_RIGHTS, values.tobytes()))
    sent = sock.sendmsg([data], ancillary)
    if sent != len(data):
        raise RuntimeError("exact-inode recovery keeper short write")


def _recovery_receive(sock):
    data, ancillary, _, _ = sock.recvmsg(
        1024 * 1024, socket.CMSG_SPACE(array.array("i", [0]).itemsize))
    if not data:
        raise RuntimeError("exact-inode recovery keeper closed")
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("exact-inode recovery keeper protocol invalid") from error
    descriptors = []
    for level, kind, value in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            values = array.array("i")
            usable = len(value) - (len(value) % values.itemsize)
            values.frombytes(value[:usable])
            descriptors.extend(values.tolist())
    for descriptor in descriptors:
        os.set_inheritable(descriptor, False)
    return payload, descriptors


def _recovery_child_close_inherited(keep):
    try:
        names = os.listdir("/proc/self/fd")
    except OSError:
        return
    for name in names:
        try:
            descriptor = int(name)
        except ValueError:
            continue
        if descriptor in (0, 1, 2, keep):
            continue
        try:
            os.close(descriptor)
        except OSError:
            pass


def _recovery_child_loop(sock):
    held = {}
    try:
        while True:
            payload, descriptors = _recovery_receive(sock)
            operation = payload.get("operation") if isinstance(payload, dict) else None
            received_descriptor = None
            try:
                if operation == "hold":
                    if len(descriptors) != 1:
                        raise RuntimeError("exact-inode recovery keeper fd missing")
                    token = int(payload["token"])
                    row = payload["row"]
                    received_descriptor = descriptors.pop()
                    verify_opened_identity(
                        received_descriptor, row, row["path"], row["type"])
                    if token in held:
                        raise RuntimeError("exact-inode recovery keeper token duplicate")
                    held[token] = received_descriptor
                    received_descriptor = None
                    _recovery_send(sock, {"ok": True})
                elif operation == "inspect":
                    for descriptor in descriptors:
                        os.close(descriptor)
                    token = int(payload["token"])
                    info = os.fstat(held[token])
                    _recovery_send(sock, {
                        "ok": True,
                        "identity": identity_from_info(info),
                        "state": list(state_tuple(info)),
                    })
                elif operation == "restore":
                    for descriptor in descriptors:
                        os.close(descriptor)
                    token = int(payload["token"])
                    record = {
                        "row": payload["row"],
                        "fd": held[token],
                        "before": tuple(payload["before"]),
                    }
                    restore_exact_record(record)
                    _recovery_send(sock, {"ok": True})
                elif operation in ("release", "abort"):
                    for descriptor in descriptors:
                        os.close(descriptor)
                    _recovery_send(sock, {"ok": True})
                    return
                else:
                    for descriptor in descriptors:
                        os.close(descriptor)
                    raise RuntimeError("exact-inode recovery keeper operation invalid")
            except Exception as error:
                if received_descriptor is not None:
                    try:
                        os.close(received_descriptor)
                    except OSError:
                        pass
                for descriptor in descriptors:
                    try:
                        os.close(descriptor)
                    except OSError:
                        pass
                _recovery_send(sock, {"ok": False, "error": str(error)})
    finally:
        for descriptor in held.values():
            try:
                os.close(descriptor)
            except OSError:
                pass


class RecoveryFdKeeper:
    """Keep a bounded shard of exact recovery fds outside the mutator process."""

    def __init__(self):
        try:
            parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            pid = os.fork()
        except (AttributeError, OSError) as error:
            raise RuntimeError(f"exact-inode recovery fd keeper unavailable:{error}") from error
        if pid == 0:
            parent.close()
            descriptor = child.fileno()
            _recovery_child_close_inherited(descriptor)
            try:
                _recovery_child_loop(child)
            except Exception:
                pass
            finally:
                child.close()
            os._exit(0)
        child.close()
        self.socket = parent
        self.pid = pid
        self.count = 0
        self.closed = False

    def request(self, payload, descriptor=None):
        if self.closed:
            raise RuntimeError("exact-inode recovery keeper already closed")
        try:
            _recovery_send(self.socket, payload, descriptor)
            response, extra = _recovery_receive(self.socket)
            for received in extra:
                os.close(received)
        except Exception as error:
            raise RuntimeError(f"exact-inode recovery keeper request failed:{error}") from error
        if not isinstance(response, dict) or response.get("ok") is not True:
            raise RuntimeError(
                f"exact-inode recovery keeper rejected request:{response.get('error', 'unknown')}")
        return response

    def hold(self, token, row, descriptor):
        self.request({"operation": "hold", "token": token, "row": row}, descriptor)
        self.count += 1

    def inspect(self, token):
        return self.request({"operation": "inspect", "token": token})

    def restore(self, record):
        return self.request({
            "operation": "restore", "token": record["recoveryToken"],
            "row": record["row"], "before": list(record["before"]),
        })

    def shutdown(self, operation):
        if self.closed:
            return
        try:
            self.request({"operation": operation})
        except Exception:
            pass
        try:
            os.waitpid(self.pid, 0)
        except OSError:
            pass
        try:
            self.socket.close()
        except OSError:
            pass
        self.closed = True


class RecoveryFdPool:
    """Shard held recovery descriptors so no process owns the whole plan."""

    def __init__(self):
        self.keepers = []

    def _keeper(self):
        if not self.keepers or self.keepers[-1].count >= RECOVERY_FD_SHARD_SIZE:
            self.keepers.append(RecoveryFdKeeper())
        return self.keepers[-1]

    def hold(self, record, descriptor):
        keeper = self._keeper()
        token = keeper.count
        keeper.hold(token, record["row"], descriptor)
        os.close(descriptor)
        record["fd"] = None
        record["recoveryKeeper"] = keeper
        record["recoveryToken"] = token

    def inspect(self, record):
        keeper = record.get("recoveryKeeper")
        if keeper is None:
            raise RuntimeError(f"exact-inode recovery keeper missing:{record['row']['path']}")
        return keeper.inspect(record["recoveryToken"])

    def restore(self, record):
        keeper = record.get("recoveryKeeper")
        if keeper is None:
            raise RuntimeError(f"exact-inode recovery keeper missing:{record['row']['path']}")
        keeper.restore(record)

    def release(self):
        for keeper in self.keepers:
            keeper.shutdown("release")

    def close(self):
        for keeper in self.keepers:
            keeper.shutdown("abort")


def before_permission_write(target, descriptor, operation):
    """Deterministic test seam; production has no hook or alternate writer."""
    return None


def row_from_info(row, info):
    return {
        **row,
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": stat.S_IMODE(info.st_mode),
        "st_dev": info.st_dev,
        "st_ino": info.st_ino,
        "st_nlink": info.st_nlink,
    }


def row_from_keeper_snapshot(row, target, snapshot):
    expected_identity = {
        "type": row["type"], "st_dev": row["st_dev"],
        "st_ino": row["st_ino"], "st_nlink": row["st_nlink"],
    }
    if snapshot.get("identity") != expected_identity:
        raise RuntimeError(f"exact-inode recovery identity drift:{target}")
    state = snapshot.get("state")
    if not isinstance(state, list) or len(state) != 3 or not all(isinstance(value, int) for value in state):
        raise RuntimeError(f"exact-inode recovery state invalid:{target}")
    return {
        **row, "uid": state[0], "gid": state[1], "mode": state[2],
    }


def exact_audit_rows(app, gid, rows, scope, validated, directory_fds, mutated,
                     recovery_pool, operation, service_uid=None):
    """Audit exact fds plus path identity without opening any recovery path."""
    records = {record["row"]["path"]: record for record in mutated}
    current_rows = []
    issues = []
    source_set = set(scope["managedSourcePaths"])
    runtime_set = {row["path"] for row in scope["managedRuntimeRoots"]}
    source_issues = []
    runtime_issues = []
    for row in sorted(rows, key=lambda value: value["path"]):
        target = row["path"]
        record = records.get(target)
        if record is not None:
            if record["fd"] is None:
                current = row_from_keeper_snapshot(
                    row, target, recovery_pool.inspect(record))
                observed_state = (current["uid"], current["gid"], current["mode"])
            else:
                info = verify_opened_identity(record["fd"], row, target, row["type"])
                current = row_from_info(row, info)
                observed_state = state_tuple(info)
        else:
            info = verify_path_identity(row, target)
            current = row_from_info(row, info)
            observed_state = state_tuple(info)
        verify_trusted_path_hierarchy(app, target, row, validated, service_uid)
        current_rows.append(current)
        expected = desired_permission_state(app, gid, row, operation)
        if observed_state != expected:
            issue = {
                "path": target, "uid": current["uid"], "gid": current["gid"],
                "mode": current["mode"], "expectedUid": expected[0],
                "expectedGid": expected[1], "expectedMode": expected[2],
            }
            issues.append(issue)
            (source_issues if target in source_set else runtime_issues).append(issue)
    source_rows = [row for row in current_rows if row["path"] in source_set]
    runtime_rows = [row for row in current_rows if row["path"] in runtime_set]
    return {
        "ok": not issues,
        "manifestSha256": digest(current_rows),
        "pathCount": len(current_rows),
        "issues": issues,
        "managedSource": {
            "manifestSha256": digest(source_rows), "pathCount": len(source_rows),
            "issues": source_issues,
        },
        "managedRuntime": {
            "roots": [row["name"] for row in scope["managedRuntimeRoots"]],
            "manifestSha256": digest(runtime_rows), "pathCount": len(runtime_rows),
            "issues": runtime_issues,
        },
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
    }


def close_transaction_fds(app_descriptor, directory_fds, mutated):
    descriptors = set(directory_fds.values())
    if app_descriptor is not None:
        descriptors.add(app_descriptor)
    descriptors.update(record["fd"] for record in mutated if record["fd"] is not None)
    for descriptor in sorted(descriptors):
        try:
            os.close(descriptor)
        except OSError:
            pass


def mutate_permissions(app, gid, rows, scope, validated, operation, service_uid=None):
    excluded = {row["path"] for row in scope["excludedRuntimeRoots"]}
    if excluded & set(validated):
        raise RuntimeError("excluded runtime root entered mutation scope")
    if app not in validated:
        raise RuntimeError("app root absent from validated mutation scope")
    mutated = []
    directory_fds = {}
    app_descriptor = None
    recovery_pool = RecoveryFdPool()
    try:
        validate_external_parent_chain(app, service_uid)
        app_descriptor = os.open(app, open_flags("directory"))
        directory_fds[app] = app_descriptor
        app_row = validated[app]
        verify_opened_identity(app_descriptor, app_row, app, "directory")
        verify_path_identity(app_row, app)
        validate_opened_state(os.fstat(app_descriptor), app_row, app, gid, operation, app)

        # Establish the in-tree no-rename boundary from parent to child.  The
        # descriptors remain open for the whole transaction and are also the
        # anchors used to open every file below them.
        directory_rows = sorted(
            (row for row in validated.values() if row["type"] == "directory"),
            key=lambda value: (value["path"].count(os.sep), value["path"]),
        )
        for row in directory_rows:
            target = row["path"]
            if target == app:
                descriptor = app_descriptor
            else:
                parent = os.path.dirname(target)
                parent_descriptor = directory_fds.get(parent)
                if parent_descriptor is None:
                    raise RuntimeError(f"permission directory parent not locked:{target}")
                descriptor = os.open(
                    os.path.basename(target), open_flags("directory"), dir_fd=parent_descriptor)
                directory_fds[target] = descriptor
            verify_opened_identity(descriptor, row, target, "directory")
            verify_path_identity(row, target)
            if target == app:
                validate_external_parent_chain(app, service_uid)
            else:
                verify_locked_ancestors(app, target, validated, directory_fds, gid, service_uid)
            info = os.fstat(descriptor)
            validate_opened_state(info, row, app, gid, operation, target)
            lock_state = (0, gid, locked_directory_mode(info))
            if state_tuple(info) != lock_state:
                recovery_record = {
                    "row": row, "fd": os.dup(descriptor), "before": state_tuple(info),
                }
                mutated.append(recovery_record)
                if target == app:
                    lock_check = lambda: (validate_external_parent_chain(app, service_uid), verify_path_identity(row, target))
                else:
                    lock_check = lambda target=target: (
                        verify_locked_ancestors(app, target, validated, directory_fds, gid, service_uid),
                        verify_path_identity(row, target),
                    )
                mutate_fd_state(descriptor, row, lock_state, trust_check=lock_check)
                recovery_pool.hold(recovery_record, recovery_record["fd"])

        # A directory whose final state is writable remains locked until all
        # descendants have been processed.  This is what makes both apply and
        # rollback safe for tracked files beneath an allowlisted runtime root.
        target_rows = [row for row in rows if row["path"] not in excluded]
        deferred_directories = {
            row["path"] for row in target_rows
            if row["type"] == "directory"
            and (desired_permission_state(app, gid, row, operation)[0] != 0
                 or desired_permission_state(app, gid, row, operation)[1] != gid
                 or desired_permission_state(app, gid, row, operation)[2] & 0o022)
        }
        if operation == "apply":
            immediate = sorted(
                (row for row in target_rows if row["path"] not in deferred_directories),
                key=lambda value: (value["path"].count(os.sep), value["path"]),
            )
        else:
            immediate = sorted(
                (row for row in target_rows if row["path"] not in deferred_directories),
                key=lambda value: (-value["path"].count(os.sep), value["path"]),
            )
        deferred = sorted(
            (row for row in target_rows if row["path"] in deferred_directories),
            key=lambda value: (-value["path"].count(os.sep), value["path"]),
        )

        for row in immediate + deferred:
            target = row["path"]
            descriptor = open_anchored_target(
                app_descriptor, app, target, row["type"], validated, directory_fds=directory_fds)
            keep_open = False
            try:
                info = verify_trusted_target(app, target, descriptor, validated, directory_fds, gid, service_uid)
                validate_opened_state(info, row, app, gid, operation, target)
                before_state = state_tuple(info)
                desired_state = desired_permission_state(app, gid, row, operation)
                if before_state != desired_state:
                    # The fd is enlisted before the first possible write and
                    # remains held until the exact global audit succeeds.
                    recovery_record = {"row": row, "fd": descriptor, "before": before_state}
                    mutated.append(recovery_record)
                    keep_open = True
                    before_permission_write(target, descriptor, operation)
                    verify_trusted_target(app, target, descriptor, validated, directory_fds, gid, service_uid)
                    mutate_fd_state(
                        descriptor, row, desired_state,
                        trust_check=lambda target=target: verify_trusted_target(
                            app, target, descriptor, validated, directory_fds, gid, service_uid),
                    )
                    final = verify_opened_identity(descriptor, row, target, row["type"])
                    recovery_pool.hold(recovery_record, descriptor)
                    descriptor = None
                else:
                    # No mutation occurred, but the same exact fd still gets
                    # an immediate readback before it is released.
                    verify_opened_identity(descriptor, row, target, row["type"])
                if descriptor is not None:
                    final = verify_opened_identity(descriptor, row, target, row["type"])
                    os.close(descriptor)
                    descriptor = None
            except Exception:
                if descriptor is not None and not keep_open:
                    os.close(descriptor)
                raise

        result = exact_audit_rows(
            app, gid, target_rows, scope, validated, directory_fds, mutated,
            recovery_pool, operation, service_uid)
        if not result["ok"]:
            raise RuntimeError("permission mutation exact terminal audit failed")
        recovery_pool.release()
        return result
    except Exception as mutation_error:
        recovery_errors = []
        for record in reversed(mutated):
            try:
                restore_exact_record(record, recovery_pool)
            except Exception as recovery_error:
                recovery_errors.append(f"{record['row']['path']}:{recovery_error}")
        if recovery_errors:
            raise RuntimeError(
                f"permission mutation partial failure; exact-inode recovery failed:{mutation_error};"
                + "|".join(recovery_errors)) from mutation_error
        raise RuntimeError(
            f"permission mutation partial failure recovered on exact inodes:{mutation_error}") from mutation_error
    finally:
        close_transaction_fds(app_descriptor, directory_fds, mutated)
        recovery_pool.close()


def apply_permissions(app, gid, rows, scope, validated, service_uid=None):
    return mutate_permissions(app, gid, rows, scope, validated, "apply", service_uid)


def restore_permissions(app, gid, rows, scope, validated, service_uid=None):
    return mutate_permissions(app, gid, rows, scope, validated, "rollback", service_uid)


def audit_rows(app, gid, rows, scope, baseline_rows=None):
    baseline_by_path = {row["path"]: row for row in (baseline_rows or rows)}
    issues = []
    source_set = set(scope["managedSourcePaths"])
    runtime_set = {row["path"] for row in scope["managedRuntimeRoots"]}
    source_rows = [row for row in rows if row["path"] in source_set]
    runtime_rows = [row for row in rows if row["path"] in runtime_set]
    source_issues = []
    runtime_issues = []
    for row in rows:
        baseline = baseline_by_path.get(row["path"], row)
        expected = desired_mode_from_row(app, baseline)
        info = os.lstat(row["path"])
        if path_type(info) != baseline["type"]:
            raise RuntimeError(f"permission path type drift:{row['path']}")
        if info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != expected:
            issue = {
                "path": row["path"], "uid": info.st_uid, "gid": info.st_gid,
                "mode": stat.S_IMODE(info.st_mode), "expectedMode": expected,
            }
            issues.append(issue)
            (source_issues if row["path"] in source_set else runtime_issues).append(issue)
    return {
        "ok": not issues,
        "manifestSha256": digest(rows),
        "pathCount": len(rows),
        "issues": issues,
        "managedSource": {
            "manifestSha256": digest(source_rows), "pathCount": len(source_rows), "issues": source_issues,
        },
        "managedRuntime": {
            "roots": [row["name"] for row in scope["managedRuntimeRoots"]],
            "manifestSha256": digest(runtime_rows), "pathCount": len(runtime_rows), "issues": runtime_issues,
        },
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
    }


def audit(app, gid, scope=None, rows=None, baseline_rows=None, service_uid=None):
    scope = scope or build_scope(app, service_uid)
    rows = rows if rows is not None else snapshot_paths(scope["managedPaths"])
    return audit_rows(scope["appRoot"], gid, rows, scope, baseline_rows=baseline_rows)


def desired_manifest_sha(app, gid, rows):
    desired = []
    for row in rows:
        desired.append({
            "path": row["path"], "type": row["type"], "uid": 0,
            "gid": gid, "mode": desired_mode_from_row(app, row),
        })
    return digest(sorted(desired, key=lambda value: value["path"]))


def load_receipt(file, expected_sha=""):
    if os.path.islink(file) or not os.path.isfile(file):
        raise RuntimeError("permission receipt must be a regular file")
    raw = open(file, "rb").read()
    actual_sha = hashlib.sha256(raw).hexdigest()
    if expected_sha and actual_sha != expected_sha:
        raise RuntimeError("receipt file SHA-256 mismatch")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise RuntimeError("permission receipt JSON invalid")
    core = dict(value)
    claimed = core.pop("receiptHash", "")
    if claimed != digest(core):
        raise RuntimeError("receipt canonical hash mismatch")
    return {**core, "receiptHash": claimed}


def completion_core(receipt_file, receipt_sha, receipt, plan_sha, rows, scope, generation,
                    completed_at=None):
    return {
        "schemaVersion": COMPLETION_SCHEMA,
        "kind": "inventory_writer_checkout_permissions_completion",
        "appRoot": receipt["appRoot"],
        "serviceGid": receipt["serviceGid"],
        "receiptFile": receipt_file,
        "receiptSha256": receipt_sha,
        "receiptHash": receipt["receiptHash"],
        "planSha256": plan_sha,
        "managedPlanRows": rows,
        "managedManifestSha256": desired_manifest_sha(receipt["appRoot"], receipt["serviceGid"], rows),
        "managedPaths": [row["path"] for row in rows],
        "managedSourcePaths": scope["managedSourcePaths"],
        "managedRuntimeRoots": scope["managedRuntimeRoots"],
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
        "sourceGeneration": generation,
        "completedAt": completed_at or datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z"),
    }


def validate_runtime_records(records, app, excluded):
    if not isinstance(records, list):
        raise RuntimeError("completion runtime roots invalid")
    names = []
    for row in records:
        if not isinstance(row, dict) or set(row) != {
                "name", "path", "excluded", "external", "reasons", "mountIdentity"}:
            raise RuntimeError("completion runtime root invalid")
        if row["name"] not in ALLOWLIST or row["name"] in names \
                or row["path"] != os.path.join(app, row["name"]) \
                or row["excluded"] is not excluded or not isinstance(row["external"], bool) \
                or not isinstance(row["reasons"], list) \
                or any(reason not in ("external-mount", "read-only-mode") for reason in row["reasons"]) \
                or row["reasons"] != list(dict.fromkeys(row["reasons"])):
            raise RuntimeError("completion runtime root binding invalid")
        if row["mountIdentity"] is not None:
            validate_mount_identity(row["mountIdentity"])
            if row["mountIdentity"]["mountpoint"] != row["path"] or not row["external"]:
                raise RuntimeError("completion runtime mount binding invalid")
        if row["external"] != ("external-mount" in row["reasons"]):
            raise RuntimeError("completion runtime external reason invalid")
        if excluded != bool(row["reasons"]):
            raise RuntimeError("completion runtime exclusion invalid")
        names.append(row["name"])
    return records


def validate_path_list(paths, app, label):
    if not isinstance(paths, list) or not paths \
            or paths != sorted(set(paths)) or any(
                not isinstance(path, str) or os.path.normpath(path) != path
                or not os.path.isabs(path) or not is_under(app, path) for path in paths):
        raise RuntimeError(f"{label} invalid")
    return paths


def historical_completion(file, receipt_file, receipt_sha, receipt):
    if os.path.islink(file) or not os.path.isfile(file):
        raise RuntimeError("completion attestation must be a regular file")
    value = json.loads(open(file, "rb").read())
    common_keys = {
        "schemaVersion", "kind", "appRoot", "serviceGid", "receiptFile", "receiptSha256",
        "receiptHash", "planSha256", "managedManifestSha256", "managedPaths",
        "managedSourcePaths", "managedRuntimeRoots", "excludedRuntimeRoots",
        "externalRuntimeMounts", "sourceGeneration", "completedAt", "attestationHash",
    }
    if not isinstance(value, dict) or value.get("schemaVersion") not in (
            LEGACY_COMPLETION_SCHEMA, COMPLETION_SCHEMA) \
            or value["kind"] != "inventory_writer_checkout_permissions_completion":
        raise RuntimeError("completion attestation schema invalid")
    expected_keys = common_keys | ({"managedPlanRows"} if value["schemaVersion"] == COMPLETION_SCHEMA else set())
    if set(value) != expected_keys:
        raise RuntimeError("completion attestation schema invalid")
    core = dict(value)
    claimed = core.pop("attestationHash")
    if not isinstance(claimed, str) or not HEX64.fullmatch(claimed) or claimed != digest(core):
        raise RuntimeError("completion attestation hash invalid")
    app = receipt["appRoot"]
    gid = receipt["serviceGid"]
    if value["appRoot"] != app or value["serviceGid"] != gid \
            or value["receiptFile"] != receipt_file or value["receiptSha256"] != receipt_sha \
            or value["receiptHash"] != receipt["receiptHash"]:
        raise RuntimeError("completion attestation receipt binding invalid")
    for key in ("receiptSha256", "receiptHash", "planSha256", "managedManifestSha256"):
        if not isinstance(value[key], str) or not HEX64.fullmatch(value[key]):
            raise RuntimeError("completion attestation hash field invalid")
    managed_paths = validate_path_list(value["managedPaths"], app, "completion managed paths")
    managed_source = validate_path_list(
        value["managedSourcePaths"], app, "completion managed source paths")
    managed_runtime = validate_runtime_records(value["managedRuntimeRoots"], app, False)
    excluded_runtime = validate_runtime_records(value["excludedRuntimeRoots"], app, True)
    if set(row["name"] for row in managed_runtime + excluded_runtime) != set(ALLOWLIST):
        raise RuntimeError("completion runtime root coverage invalid")
    validate_mount_identities(value["externalRuntimeMounts"])
    mounted = sorted(
        [row["mountIdentity"] for row in managed_runtime + excluded_runtime
         if row["mountIdentity"] is not None],
        key=lambda row: (row["mountpoint"], row["mountId"]),
    )
    if mounted != value["externalRuntimeMounts"]:
        raise RuntimeError("completion mount identity manifest invalid")
    if set(managed_paths) != set(managed_source) | {row["path"] for row in managed_runtime}:
        raise RuntimeError("completion managed path coverage invalid")
    before = {row["path"]: row for row in receipt["before"]}
    if any(path not in before for path in managed_paths):
        raise RuntimeError("completion path absent from receipt")
    if value["schemaVersion"] == COMPLETION_SCHEMA:
        rows = value["managedPlanRows"]
        if not isinstance(rows, list) or [row.get("path") for row in rows] != managed_paths:
            raise RuntimeError("completion managed plan rows invalid")
        for row in rows:
            validate_identity_row(row, app, "completion managed plan row")
            if metadata_row(row) != metadata_row(before[row["path"]]):
                raise RuntimeError("completion managed plan receipt drift")
        plan_schema = PLAN_SCHEMA
    else:
        rows = [before[path] for path in managed_paths]
        plan_schema = LEGACY_PLAN_SCHEMA
    if any(row["type"] in ("symlink", "other") for row in rows):
        raise RuntimeError("completion contains unsafe managed path")
    generation = validate_source_generation(
        value["sourceGeneration"], managed_source, managed_runtime, value["externalRuntimeMounts"])
    historical_scope = {
        "appRoot": app,
        "managedSourcePaths": managed_source,
        "managedRuntimeRoots": managed_runtime,
        "excludedRuntimeRoots": excluded_runtime,
        "externalRuntimeMounts": value["externalRuntimeMounts"],
        "managedPaths": managed_paths,
    }
    payload = plan_payload(historical_scope, gid, rows, generation, schema=plan_schema)
    plan_sha = plan_hash(payload)
    if value["planSha256"] != plan_sha \
            or value["managedManifestSha256"] != desired_manifest_sha(app, gid, rows):
        raise RuntimeError("completion historical plan binding invalid")
    if receipt.get("planSha256") is not None and receipt["planSha256"] != plan_sha:
        raise RuntimeError("completion receipt plan binding invalid")
    if receipt.get("sourceGeneration") is not None and receipt["sourceGeneration"] != generation:
        raise RuntimeError("completion receipt generation binding invalid")
    if receipt.get("externalRuntimeMounts") is not None \
            and receipt["externalRuntimeMounts"] != value["externalRuntimeMounts"]:
        raise RuntimeError("completion receipt mount binding invalid")
    return value, rows, historical_scope, payload


def validate_receipt_scope(receipt, scope, plan_sha, generation):
    if receipt.get("externalRuntimeMounts") is not None \
            and receipt["externalRuntimeMounts"] != scope["externalRuntimeMounts"]:
        raise RuntimeError("permission receipt external mount identity drift")
    if receipt.get("planSha256") is not None and receipt["planSha256"] != plan_sha:
        raise RuntimeError("permission receipt recovery plan drift")
    if receipt.get("sourceGeneration") is not None and receipt["sourceGeneration"] != generation:
        raise RuntimeError("permission receipt source generation drift")


def build_receipt(app, gid, service_group, before, scope, plan_sha, generation):
    core = {
        "schemaVersion": SCHEMA, "kind": "inventory_writer_checkout_permissions",
        "appRoot": app, "serviceGroup": service_group, "serviceGid": gid,
        "before": before, "beforeManifestSha256": digest(before),
        "managedPaths": [row["path"] for row in before],
        "planSha256": plan_sha, "sourceGeneration": generation,
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
        "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(
            timespec="milliseconds").replace("+00:00", "Z"),
    }
    return {**core, "receiptHash": digest(core)}


def audit_current_scope(app, gid, scope):
    rows = snapshot_paths(scope["managedPaths"])
    source = set(scope["managedSourcePaths"])
    runtime = {row["path"]: row for row in scope["managedRuntimeRoots"]}
    source_rows = [row for row in rows if row["path"] in source]
    runtime_rows = [row for row in rows if row["path"] in runtime]
    source_issues = []
    runtime_issues = []
    for row in source_rows:
        unsafe = row["type"] not in ("directory", "file") or row["uid"] != 0 or row["mode"] & 0o022
        if row["path"] == app:
            unsafe = unsafe or row["type"] != "directory" or bool(row["mode"] & 0o027)
        if unsafe:
            source_issues.append({"path": row["path"], "uid": row["uid"], "gid": row["gid"],
                                  "mode": row["mode"], "policy": "root-owned-non-writable-source"})
    for row in runtime_rows:
        expected = desired_mode_from_row(app, row)
        if row["type"] != "directory" or row["uid"] != 0 or row["gid"] != gid or row["mode"] != expected:
            runtime_issues.append({"path": row["path"], "uid": row["uid"], "gid": row["gid"],
                                   "mode": row["mode"], "expectedMode": expected})
    issues = source_issues + runtime_issues
    return {
        "ok": not issues, "policy": "root-controlled-current-source",
        "manifestSha256": digest(rows), "pathCount": len(rows), "issues": issues,
        "managedSource": {"manifestSha256": digest(source_rows), "pathCount": len(source_rows),
                          "issues": source_issues},
        "managedRuntime": {"roots": [row["name"] for row in scope["managedRuntimeRoots"]],
                           "manifestSha256": digest(runtime_rows), "pathCount": len(runtime_rows),
                           "issues": runtime_issues},
        "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
        "externalRuntimeMounts": scope["externalRuntimeMounts"],
    }


def validate_completed_mount_scope(completion, current_scope):
    if completion["externalRuntimeMounts"] != current_scope["externalRuntimeMounts"] \
            or completion["managedRuntimeRoots"] != current_scope["managedRuntimeRoots"] \
            or completion["excludedRuntimeRoots"] != current_scope["excludedRuntimeRoots"]:
        raise RuntimeError("completed generation runtime mount identity drift")


def artifact_paths(app, receipt_file, plan_file, completion_file):
    values = [receipt_file, plan_file, completion_file]
    if not plan_file or len(set(values)) != 3 or any(is_under(app, path) for path in values):
        raise RuntimeError("generation artifacts must be distinct paths outside app root")


def frozen_plan_from_file(plan_file, expected_hash, scope, gid, generation, receipt_rows=None):
    if not plan_file:
        raise RuntimeError("exact immutable permission plan file required")
    value, _ = load_plan_file(plan_file, expected_hash)
    rows = validate_plan_binding(value, scope, gid, generation, receipt_rows=receipt_rows)
    return value, rows


def build_frozen_plan(scope, gid, source_rows, generation, operation="recovery"):
    validate_exact_source_clean(scope["appRoot"])
    if all(isinstance(row, dict) and set(row) == IDENTITY_ROW_KEYS for row in source_rows):
        rows = [dict(row) for row in source_rows]
        for row in rows:
            validate_identity_row(row, scope["appRoot"])
    else:
        rows = capture_plan_rows(source_rows, scope["appRoot"], gid, scope, operation)
    validate_exact_source_clean(scope["appRoot"])
    payload = plan_payload(scope, gid, rows, generation)
    return payload, rows, plan_hash(payload)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", default="/opt/shein-bi/app")
    parser.add_argument("--service-group", default="sheinops")
    parser.add_argument("--receipt", default="/var/lib/shein-bi-control/inventory-writer-compatibility/source-permissions.receipt.json")
    parser.add_argument("--completion-attestation", default="")
    parser.add_argument("--plan-file", default="")
    parser.add_argument("--generation-id", default="")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--expected-receipt-sha256", default="")
    parser.add_argument("--expected-recovery-plan-sha256", default="")
    return parser.parse_args()


def emit(value):
    print(json.dumps(value, separators=(",", ":")))


def main():
    args = parse_args()
    app = os.path.normpath(os.path.abspath(args.app_root))
    receipt_file = os.path.normpath(os.path.abspath(args.receipt))
    completion_file = os.path.normpath(os.path.abspath(
        args.completion_attestation or f"{receipt_file}.completion.json"))
    plan_file = os.path.normpath(os.path.abspath(args.plan_file)) if args.plan_file else ""
    ensure_no_symlink_parent(receipt_file)
    ensure_no_symlink_parent(completion_file)
    if plan_file:
        ensure_no_symlink_parent(plan_file)
    gid = int(args.service_group) if args.service_group.isdigit() else grp.getgrnam(args.service_group).gr_gid
    global _RESOLVED_SERVICE_UID
    service_uid = resolve_service_uid(args.service_group)
    _RESOLVED_SERVICE_UID = service_uid
    if args.apply and args.rollback:
        raise RuntimeError("choose apply or rollback")

    if args.apply:
        if os.geteuid() != 0 or args.confirm != APPLY_CONFIRM:
            raise RuntimeError("root and exact apply confirmation required")
        if os.path.lexists(receipt_file):
            if not args.expected_receipt_sha256 or not HEX64.fullmatch(args.expected_receipt_sha256) \
                    or not args.expected_recovery_plan_sha256 \
                    or not HEX64.fullmatch(args.expected_recovery_plan_sha256):
                raise RuntimeError("existing receipt requires exact receipt and recovery plan SHA-256")
            receipt = load_receipt(receipt_file, args.expected_receipt_sha256)
            validate_receipt(receipt, app, gid)
            scope = build_scope(app, service_uid)
            validate_fresh_scope(scope)
            if os.path.lexists(completion_file):
                completion, _, historical_scope, payload = historical_completion(
                    completion_file, receipt_file, args.expected_receipt_sha256, receipt)
                validate_completed_mount_scope(completion, scope)
                plan_sha = plan_hash(payload)
                if args.expected_recovery_plan_sha256 != plan_sha:
                    raise RuntimeError("recovery plan SHA-256 mismatch")
                if plan_file:
                    validate_plan_file(plan_file, plan_sha, payload)
                current_generation = source_generation(scope, f"current:{git(app, 'rev-parse', 'HEAD').decode('ascii').strip()}")
                if current_generation["generationHash"] != completion["sourceGeneration"]["generationHash"]:
                    raise RuntimeError("completed receipt cannot authorize a different source generation")
                result = audit_current_scope(app, gid, scope)
                if not result["ok"]:
                    raise RuntimeError("completed generation current source audit failed")
                emit({**result, "state": "already_hardened", "mutationAuthorized": False,
                      "receiptFile": receipt_file, "receiptSha256": args.expected_receipt_sha256,
                      "receiptHash": receipt["receiptHash"], "planSha256": plan_sha,
                      "completionAttestation": completion_file,
                      "historicalManagedPathCount": len(historical_scope["managedPaths"])})
                return
            rows = receipt_rows_for_scope(receipt, scope)
            generation = generation_for_receipt(receipt, scope)
            plan, plan_rows = frozen_plan_from_file(
                plan_file, args.expected_recovery_plan_sha256, scope, gid, generation,
                receipt_rows=rows)
            plan_sha = plan["planHash"]
            validate_receipt_scope(receipt, scope, plan_sha, generation)
            validate_exact_source_clean(app)
            ensure_no_symlink_parent(completion_file)
            validated = validate_current_rows(plan_rows, app, gid, scope, "apply", service_uid)
            result = apply_permissions(app, gid, plan_rows, scope, validated, service_uid)
            core = completion_core(
                receipt_file, args.expected_receipt_sha256, receipt, plan_sha, plan_rows, scope, generation)
            write_atomic_no_replace(completion_file, {**core, "attestationHash": digest(core)})
            emit({**result, "state": "hardened", "mutationAuthorized": True,
                  "receiptFile": receipt_file, "receiptSha256": args.expected_receipt_sha256,
                  "receiptHash": receipt["receiptHash"], "planSha256": plan_sha,
                  "completionAttestation": completion_file})
            return

        if args.expected_receipt_sha256:
            raise RuntimeError("expected receipt SHA-256 is only valid for receipt recovery")
        if not args.generation_id or not args.plan_file or not args.completion_attestation \
                or not args.expected_recovery_plan_sha256 \
                or not HEX64.fullmatch(args.expected_recovery_plan_sha256):
            raise RuntimeError("new generation apply requires explicit generation id, plan, exact plan SHA and completion artifacts")
        artifact_paths(app, receipt_file, plan_file, completion_file)
        scope = build_scope(app, service_uid)
        generation = source_generation(scope, args.generation_id)
        plan, before = frozen_plan_from_file(
            plan_file, args.expected_recovery_plan_sha256, scope, gid, generation)
        plan_sha = plan["planHash"]
        validate_exact_source_clean(app)
        ensure_no_symlink_parent(receipt_file)
        ensure_no_symlink_parent(completion_file)
        validated = validate_current_rows(before, app, gid, scope, "apply", service_uid)
        validate_fresh_scope(scope)
        if os.path.lexists(completion_file):
            raise RuntimeError("completion attestation exists without receipt")
        receipt = build_receipt(app, gid, args.service_group, before, scope, plan_sha, generation)
        write_atomic_no_replace(receipt_file, receipt)
        receipt_sha = file_sha256(receipt_file)
        validate_fresh_scope(scope)
        result = apply_permissions(app, gid, before, scope, validated, service_uid)
        core = completion_core(receipt_file, receipt_sha, receipt, plan_sha, before, scope, generation)
        write_atomic_no_replace(completion_file, {**core, "attestationHash": digest(core)})
        emit({**result, "state": "hardened", "mutationAuthorized": True,
              "receiptFile": receipt_file, "receiptSha256": receipt_sha,
              "receiptHash": receipt["receiptHash"], "planSha256": plan_sha,
              "completionAttestation": completion_file, "sourceGeneration": generation})
        return

    if args.rollback:
        if os.geteuid() != 0 or args.confirm != ROLLBACK_CONFIRM or not plan_file \
                or not args.expected_receipt_sha256 or not HEX64.fullmatch(args.expected_receipt_sha256) \
                or not args.expected_recovery_plan_sha256 or not HEX64.fullmatch(args.expected_recovery_plan_sha256):
            raise RuntimeError("root, exact rollback confirmation, receipt SHA-256 and recovery plan hash required")
        receipt = load_receipt(receipt_file, args.expected_receipt_sha256)
        validate_receipt(receipt, app, gid)
        scope = build_scope(app, service_uid)
        rows = receipt_rows_for_scope(receipt, scope)
        generation = generation_for_receipt(receipt, scope)
        plan, plan_rows = frozen_plan_from_file(
            plan_file, args.expected_recovery_plan_sha256, scope, gid, generation,
            receipt_rows=rows)
        plan_sha = plan["planHash"]
        validate_receipt_scope(receipt, scope, plan_sha, generation)
        validate_exact_source_clean(app)
        validated = validate_current_rows(plan_rows, app, gid, scope, "rollback", service_uid)
        validate_fresh_scope(scope)
        restore_permissions(app, gid, plan_rows, scope, validated, service_uid)
        emit({"ok": True, "state": "rolled_back", "receiptHash": receipt["receiptHash"],
              "receiptSha256": args.expected_receipt_sha256, "planSha256": plan_sha,
              "externalRuntimeMounts": scope["externalRuntimeMounts"]})
        return

    scope = build_scope(app, service_uid)
    validate_fresh_scope(scope)
    if os.path.lexists(receipt_file):
        receipt = load_receipt(receipt_file)
        validate_receipt(receipt, app, gid)
        receipt_sha = file_sha256(receipt_file)
        if os.path.lexists(completion_file):
            completion, _, historical_scope, payload = historical_completion(
                completion_file, receipt_file, receipt_sha, receipt)
            validate_completed_mount_scope(completion, scope)
            plan_sha = plan_hash(payload)
            if plan_file:
                ensure_no_symlink_parent(plan_file)
                validate_plan_file(plan_file, plan_sha, payload)
            current_generation = source_generation(
                scope, f"current:{git(app, 'rev-parse', 'HEAD').decode('ascii').strip()}")
            relation = "current_scope_matches_completed_generation" \
                if current_generation["generationHash"] == completion["sourceGeneration"]["generationHash"] \
                else "historical_completion_current_scope_advanced"
            result = audit_current_scope(app, gid, scope)
            current_scope_hash = digest({
                "sourceGeneration": current_generation,
                "managedSourcePaths": scope["managedSourcePaths"],
                "managedRuntimeRoots": scope["managedRuntimeRoots"],
                "excludedRuntimeRoots": scope["excludedRuntimeRoots"],
                "externalRuntimeMounts": scope["externalRuntimeMounts"],
            })
            emit({**result, "state": "audit_current_generation", "mutationAuthorized": False,
                  "recoveryRequired": False, "planSha256": plan_sha,
                  "receiptFile": receipt_file, "receiptSha256": receipt_sha,
                  "receiptHash": receipt["receiptHash"],
                  "historicalCompletion": {
                      "file": completion_file, "attestationHash": completion["attestationHash"],
                      "receiptSha256": completion["receiptSha256"],
                      "receiptHash": completion["receiptHash"],
                      "planSha256": completion["planSha256"],
                      "sourceGeneration": completion["sourceGeneration"],
                      "managedPathCount": len(historical_scope["managedPaths"]),
                  },
                  "currentGeneration": current_generation, "generationRelation": relation,
                  "currentScopeSha256": current_scope_hash})
            return
        rows = receipt_rows_for_scope(receipt, scope)
        generation = generation_for_receipt(receipt, scope)
        if plan_file:
            ensure_no_symlink_parent(plan_file)
            if os.path.lexists(plan_file):
                expected_plan_sha = receipt.get("planSha256", "")
                plan, plan_rows = frozen_plan_from_file(
                    plan_file, expected_plan_sha, scope, gid, generation, receipt_rows=rows)
                plan_sha = plan["planHash"]
            else:
                payload, plan_rows, plan_sha = build_frozen_plan(
                    scope, gid, rows, generation, operation="recovery")
                write_atomic_no_replace(plan_file, {**payload, "planHash": plan_sha})
        else:
            raise RuntimeError("recovery audit requires immutable permission plan file")
        validate_receipt_scope(receipt, scope, plan_sha, generation)
        result = audit_rows(app, gid, snapshot_paths(scope["managedPaths"]), scope, baseline_rows=rows)
        emit({**result, "state": "audit_recovery_generation", "planSha256": plan_sha,
              "receiptFile": receipt_file, "receiptSha256": receipt_sha,
              "receiptHash": receipt["receiptHash"], "sourceGeneration": generation,
              "recoveryRequired": True, "mutationAuthorized": True})
        return

    if os.path.lexists(completion_file):
        raise RuntimeError("completion attestation exists without receipt")
    generation_id = args.generation_id or f"current:{git(app, 'rev-parse', 'HEAD').decode('ascii').strip()}"
    generation = source_generation(scope, generation_id)
    source_rows = [metadata_row(row) for row in snapshot_paths(scope["managedPaths"])]
    payload, rows, plan_sha = build_frozen_plan(
        scope, gid, source_rows, generation, operation="apply")
    if plan_file:
        artifact_paths(app, receipt_file, plan_file, completion_file)
        ensure_no_symlink_parent(plan_file)
        if os.path.lexists(plan_file):
            validate_plan_file(plan_file, plan_sha, payload)
        else:
            write_atomic_no_replace(plan_file, {**payload, "planHash": plan_sha})
    result = audit_current_scope(app, gid, scope)
    emit({**result, "state": "audit_new_generation", "planSha256": plan_sha,
          "receiptFile": receipt_file, "receiptSha256": "", "receiptHash": "",
          "sourceGeneration": generation, "recoveryRequired": False,
          "mutationAuthorized": bool(args.generation_id and plan_file)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
