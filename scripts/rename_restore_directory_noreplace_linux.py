#!/usr/bin/env python3
"""Atomically publish one restored directory with renameat2(RENAME_NOREPLACE)."""

import argparse
import ctypes
import errno
import json
import os
import stat
import sys


RENAME_NOREPLACE = 1


def emit(payload, exit_code):
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True), flush=True)
    raise SystemExit(exit_code)


def identity(value):
    return {"dev": str(value.st_dev), "ino": str(value.st_ino)}


def parse_identity(value, label):
    if not value or not value.isdecimal():
        raise ValueError(f"{label} must be an unsigned decimal integer")
    return int(value, 10)


def validate_basename(value, label):
    if not value or value in (".", "..") or "/" in value or "\0" in value:
        raise ValueError(f"{label} must be one plain directory entry name")
    return value


def validate_parent_stat(value, expected_dev, expected_ino, label):
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise RuntimeError(f"{label} is not a real non-symlink directory")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError(f"{label} dev:ino no longer matches the Node binding")
    euid = os.geteuid()
    if value.st_uid not in (0, euid):
        raise RuntimeError(f"{label} must be owned by euid {euid} or root (found uid {value.st_uid})")
    if stat.S_IMODE(value.st_mode) & 0o022:
        raise RuntimeError(f"{label} must not be group/world writable")


def validate_directory_identity(value, expected_dev, expected_ino, label):
    if stat.S_ISLNK(value.st_mode) or not stat.S_ISDIR(value.st_mode):
        raise RuntimeError(f"{label} is not a real non-symlink directory")
    if (value.st_dev, value.st_ino) != (expected_dev, expected_ino):
        raise RuntimeError(f"{label} dev:ino does not match the captured staging directory")
    if value.st_uid != os.geteuid():
        raise RuntimeError(f"{label} must remain owned by euid {os.geteuid()}")
    if stat.S_IMODE(value.st_mode) & 0o022:
        raise RuntimeError(f"{label} must not be group/world writable")


def parser():
    result = argparse.ArgumentParser(add_help=False)
    result.add_argument("--parent", required=True)
    result.add_argument("--source", required=True)
    result.add_argument("--destination", required=True)
    result.add_argument("--expected-parent-dev", required=True)
    result.add_argument("--expected-parent-ino", required=True)
    result.add_argument("--expected-staging-dev", required=True)
    result.add_argument("--expected-staging-ino", required=True)
    return result


def main():
    args = parser().parse_args()
    source = validate_basename(args.source, "source")
    destination = validate_basename(args.destination, "destination")
    if source == destination:
        raise ValueError("source and destination names must differ")

    expected_parent_dev = parse_identity(args.expected_parent_dev, "expected parent dev")
    expected_parent_ino = parse_identity(args.expected_parent_ino, "expected parent ino")
    expected_staging_dev = parse_identity(args.expected_staging_dev, "expected staging dev")
    expected_staging_ino = parse_identity(args.expected_staging_ino, "expected staging ino")

    required_flags = ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC")
    missing_flags = [name for name in required_flags if not hasattr(os, name)]
    if missing_flags:
        raise RuntimeError(
            "atomic restore publication requires Linux directory-open flags: "
            + ", ".join(missing_flags)
        )

    parent_path_stat = os.lstat(args.parent)
    validate_parent_stat(
        parent_path_stat,
        expected_parent_dev,
        expected_parent_ino,
        "destination parent path",
    )

    parent_fd = os.open(
        args.parent,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    published = False
    try:
        validate_parent_stat(
            os.fstat(parent_fd),
            expected_parent_dev,
            expected_parent_ino,
            "opened destination parent",
        )
        validate_parent_stat(
            os.lstat(args.parent),
            expected_parent_dev,
            expected_parent_ino,
            "destination parent path readback",
        )

        source_stat = os.stat(source, dir_fd=parent_fd, follow_symlinks=False)
        validate_directory_identity(
            source_stat,
            expected_staging_dev,
            expected_staging_ino,
            "staging source",
        )

        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = getattr(libc, "renameat2", None)
        if renameat2 is None:
            raise RuntimeError(
                "libc renameat2 is unavailable; install a libc exposing renameat2 "
                "or run the restore on a supported Linux host"
            )
        renameat2.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameat2.restype = ctypes.c_int
        ctypes.set_errno(0)
        result = renameat2(
            parent_fd,
            os.fsencode(source),
            parent_fd,
            os.fsencode(destination),
            RENAME_NOREPLACE,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            error_name = errno.errorcode.get(error_number, f"ERRNO_{error_number}")
            if error_number == errno.ENOSYS:
                detail = "the running Linux kernel does not implement renameat2"
            elif error_number == errno.EINVAL:
                detail = "the destination filesystem does not support RENAME_NOREPLACE"
            else:
                detail = os.strerror(error_number)
            emit(
                {
                    "ok": False,
                    "publicationSucceeded": False,
                    "errorCode": error_name,
                    "error": f"renameat2(RENAME_NOREPLACE) failed: {detail}",
                },
                1,
            )

        published = True
        destination_stat = os.stat(destination, dir_fd=parent_fd, follow_symlinks=False)
        validate_directory_identity(
            destination_stat,
            expected_staging_dev,
            expected_staging_ino,
            "published destination",
        )
        validate_parent_stat(
            os.lstat(args.parent),
            expected_parent_dev,
            expected_parent_ino,
            "destination parent path after publication",
        )

        fsync_status = "ok"
        try:
            os.fsync(parent_fd)
        except OSError as error:
            # After the no-replace rename, a durable restore requires the
            # parent directory fsync to return exactly ok.  Any other
            # outcome, whether an unsupported/ENOTSUP/EOPNOTSUPP result or a
            # real I/O error, means the rename already happened but durability
            # is unconfirmed, so this helper must never report success.
            unsupported = {errno.EINVAL}
            if hasattr(errno, "ENOTSUP"):
                unsupported.add(errno.ENOTSUP)
            if hasattr(errno, "EOPNOTSUPP"):
                unsupported.add(errno.EOPNOTSUPP)
            error_name = errno.errorcode.get(error.errno, f"ERRNO_{error.errno}")
            fsync_status = (
                ("unsupported" if error.errno in unsupported else "failed") + f":{error_name}"
            )
            emit(
                {
                    "ok": False,
                    "publicationSucceeded": True,
                    "manualInspectionRequired": True,
                    "errorCode": error_name,
                    "fsync": fsync_status,
                    "error": (
                        "renameat2(RENAME_NOREPLACE) succeeded but the parent directory fsync "
                        f"did not confirm durability ({fsync_status}); the restored destination "
                        "is published with unconfirmed durability and manual inspection is required"
                    ),
                },
                1,
            )

        final_destination_stat = os.stat(destination, dir_fd=parent_fd, follow_symlinks=False)
        validate_directory_identity(
            final_destination_stat,
            expected_staging_dev,
            expected_staging_ino,
            "published destination terminal readback",
        )
        validate_parent_stat(
            os.lstat(args.parent),
            expected_parent_dev,
            expected_parent_ino,
            "destination parent terminal readback",
        )
        emit(
            {
                "ok": True,
                "publicationSucceeded": True,
                "method": "renameat2(RENAME_NOREPLACE)",
                "fsync": fsync_status,
                "parent": identity(os.fstat(parent_fd)),
                "destination": identity(final_destination_stat),
            },
            0,
        )
    except SystemExit:
        raise
    except Exception as error:
        emit(
            {
                "ok": False,
                "publicationSucceeded": published,
                "manualInspectionRequired": published,
                "errorCode": type(error).__name__,
                "error": str(error),
            },
            1,
        )
    finally:
        os.close(parent_fd)


if __name__ == "__main__":
    if sys.platform != "linux":
        emit(
            {
                "ok": False,
                "publicationSucceeded": False,
                "errorCode": "UNSUPPORTED_PLATFORM",
                "error": "renameat2(RENAME_NOREPLACE) restore publication requires Linux",
            },
            1,
        )
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        emit(
            {
                "ok": False,
                "publicationSucceeded": False,
                "errorCode": type(error).__name__,
                "error": str(error),
            },
            1,
        )
