#!/usr/bin/python3
"""Root-controlled, exact-path source hardening for inventory writer checkouts."""

import argparse
import datetime
import grp
import hashlib
import json
import os
import stat
import subprocess
import sys

APPLY_CONFIRM = "HARDEN_INVENTORY_WRITER_CHECKOUT_V1"
ROLLBACK_CONFIRM = "ROLLBACK_INVENTORY_WRITER_CHECKOUT_V1"
SCHEMA = "inventory-writer-checkout-permissions/v1"
ALLOWLIST = ("state", "tmp", "outputs", "profiles", "node_modules")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def git(app, *args):
    result = subprocess.run(
        ["git", "-c", f"safe.directory={app}", *args], cwd=app,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    if result.returncode:
        raise RuntimeError(f"git failed:{args}:{result.returncode}")
    return result.stdout


def tracked(app):
    return [row.decode() for row in git(app, "ls-files", "-z").split(b"\0") if row]


def path_type(info):
    if stat.S_ISDIR(info.st_mode): return "directory"
    if stat.S_ISREG(info.st_mode): return "file"
    if stat.S_ISLNK(info.st_mode): return "symlink"
    return "other"


def inventory_paths(app):
    values = {app}
    git_dir = os.path.join(app, ".git")
    if not os.path.isdir(git_dir) or os.path.islink(git_dir):
        raise RuntimeError(".git must be a real directory")
    for current, directories, files in os.walk(git_dir, followlinks=False):
        values.add(current)
        values.update(os.path.join(current, name) for name in directories + files)
    for relative in tracked(app):
        current = os.path.join(app, relative)
        if not os.path.lexists(current): raise RuntimeError(f"tracked path missing:{relative}")
        values.add(current)
        current = os.path.dirname(current)
        while current != app:
            values.add(current)
            current = os.path.dirname(current)
    for name in ALLOWLIST:
        current = os.path.join(app, name)
        if not os.path.isdir(current) or os.path.islink(current):
            raise RuntimeError(f"runtime allowlist root must be a real directory or bind mount:{name}")
        values.add(current)
    return sorted(values)


def snapshot(app):
    rows = []
    for target in inventory_paths(app):
        info = os.lstat(target)
        rows.append({
            "path": target, "type": path_type(info), "uid": info.st_uid, "gid": info.st_gid,
            "mode": stat.S_IMODE(info.st_mode),
        })
    return rows


def write_atomic(file, value):
    os.makedirs(os.path.dirname(file), exist_ok=True)
    temporary = f"{file}.tmp-{os.getpid()}"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(canonical(value) + b"\n"); stream.flush(); os.fsync(stream.fileno())
    finally:
        os.close(descriptor)
    os.replace(temporary, file)
    directory = os.open(os.path.dirname(file), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(directory)
    finally: os.close(directory)


def desired_mode(app, target, info):
    relative = os.path.relpath(target, app).replace(os.sep, "/")
    if target == app: return 0o750
    if relative in ALLOWLIST: return 0o1770
    if stat.S_ISDIR(info.st_mode): return 0o750
    if stat.S_ISREG(info.st_mode): return 0o750 if info.st_mode & 0o111 else 0o640
    raise RuntimeError(f"unsupported source path type:{target}")


def apply_permissions(app, gid):
    paths = inventory_paths(app)
    for target in sorted(paths, key=lambda value: (value == app, value.count(os.sep)), reverse=True):
        info = os.lstat(target)
        if stat.S_ISLNK(info.st_mode): raise RuntimeError(f"symlink in source authority:{target}")
        os.chown(target, 0, gid)
        os.chmod(target, desired_mode(app, target, info))


def audit(app, gid):
    issues = []
    rows = snapshot(app)
    for row in rows:
        info = os.lstat(row["path"])
        expected = desired_mode(app, row["path"], info)
        if info.st_uid != 0 or info.st_gid != gid or stat.S_IMODE(info.st_mode) != expected:
            issues.append({"path": row["path"], "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode), "expectedMode": expected})
    return {"ok": not issues, "manifestSha256": digest(rows), "pathCount": len(rows), "issues": issues}


def load_receipt(file, expected_sha):
    raw = open(file, "rb").read()
    if hashlib.sha256(raw).hexdigest() != expected_sha: raise RuntimeError("receipt file SHA-256 mismatch")
    value = json.loads(raw)
    claimed = value.pop("receiptHash", "")
    if claimed != digest(value): raise RuntimeError("receipt canonical hash mismatch")
    value["receiptHash"] = claimed
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", default="/opt/shein-bi/app")
    parser.add_argument("--service-group", default="sheinops")
    parser.add_argument("--receipt", default="/var/lib/shein-bi-control/inventory-writer-compatibility/source-permissions.receipt.json")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--confirm", default="")
    parser.add_argument("--expected-receipt-sha256", default="")
    args = parser.parse_args()
    app = os.path.abspath(args.app_root)
    receipt_file = os.path.abspath(args.receipt)
    gid = int(args.service_group) if args.service_group.isdigit() else grp.getgrnam(args.service_group).gr_gid
    if args.apply and args.rollback: raise RuntimeError("choose apply or rollback")
    if args.apply:
        if os.geteuid() != 0 or args.confirm != APPLY_CONFIRM: raise RuntimeError("root and exact apply confirmation required")
        if os.path.lexists(receipt_file): raise RuntimeError("permission receipt already exists")
        before = snapshot(app)
        core = {
            "schemaVersion": SCHEMA, "kind": "inventory_writer_checkout_permissions",
            "appRoot": app, "serviceGroup": args.service_group, "serviceGid": gid,
            "before": before, "beforeManifestSha256": digest(before),
            "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        }
        receipt = {**core, "receiptHash": digest(core)}
        write_atomic(receipt_file, receipt)
        apply_permissions(app, gid)
        result = audit(app, gid)
        if not result["ok"]: raise RuntimeError("post-hardening audit failed")
        print(json.dumps({**result, "state": "hardened", "receiptFile": receipt_file, "receiptHash": receipt["receiptHash"]}, separators=(",", ":")))
        return
    if args.rollback:
        if os.geteuid() != 0 or args.confirm != ROLLBACK_CONFIRM or not args.expected_receipt_sha256:
            raise RuntimeError("root, exact rollback confirmation and receipt SHA-256 required")
        receipt = load_receipt(receipt_file, args.expected_receipt_sha256)
        if receipt.get("schemaVersion") != SCHEMA or receipt.get("appRoot") != app: raise RuntimeError("receipt binding invalid")
        for row in sorted(receipt["before"], key=lambda value: value["path"].count(os.sep), reverse=True):
            info = os.lstat(row["path"])
            if path_type(info) != row["type"]: raise RuntimeError(f"rollback path type drift:{row['path']}")
            os.chown(row["path"], row["uid"], row["gid"])
            if row["type"] != "symlink": os.chmod(row["path"], row["mode"])
        print(json.dumps({"ok": True, "state": "rolled_back", "receiptHash": receipt["receiptHash"]}, separators=(",", ":")))
        return
    print(json.dumps({**audit(app, gid), "state": "audit"}, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
