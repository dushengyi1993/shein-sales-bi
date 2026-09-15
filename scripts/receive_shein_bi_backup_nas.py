#!/usr/bin/env python3
"""Forced-command receiver for the half-managed (shein-bi) database archive.

Adapted from the full-managed receiver proven on 2026-09-05. It accepts no
destination argument and no shell command: the only input is one JSON header
line plus exactly the declared number of bytes.
"""
import fcntl
import hashlib
import json
import os
import re
import stat
import sys
import uuid

ROOT = '/vol3/shein-bi-backups'
MAX_BYTES = 100 * 1024 ** 3
KEEP_COPIES = 14
NAME = re.compile(r'shein-bi-\d{8}-\d{6}\.dump\Z')
SHA = re.compile(r'[a-f0-9]{64}\Z')


class Refused(Exception):
    pass


def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    h = hashlib.sha256()
    size = 0
    while True:
        b = os.read(fd, 1024 * 1024)
        if not b:
            return size, h.hexdigest()
        size += len(b)
        h.update(b)


def prune(directory, keep=KEEP_COPIES, protect=None):
    # Bounded retention: only exact-pattern regular files, never symlinks.
    # The archive name embeds a sortable stamp, so the newest copies are the
    # lexicographically largest names. Anything outside this receiver's own
    # namespace is never touched, and neither the lock nor .partial files are
    # candidates.
    names = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name == protect or entry.name.startswith('.'):
                continue
            if not NAME.fullmatch(entry.name):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                continue
            names.append(entry.name)
    names.sort()
    removed = []
    for name in (names[:-keep] if len(names) > keep else []):
        try:
            os.unlink(name, dir_fd=directory)
            removed.append(name)
        except FileNotFoundError:
            pass
    if removed:
        os.fsync(directory)
    return removed

def receive(stream, root=ROOT):
    header = stream.readline(4097)
    if len(header) > 4096 or not header.endswith(b'\n'):
        raise Refused('HEADER_INVALID')
    try:
        meta = json.loads(header)
    except (ValueError, UnicodeError):
        raise Refused('HEADER_INVALID')
    if (not isinstance(meta, dict)
            or set(meta) != {'version', 'name', 'bytes', 'sha256'}
            or type(meta['version']) is not int or meta['version'] != 1
            or not isinstance(meta['name'], str) or not NAME.fullmatch(meta['name'])
            or type(meta['bytes']) is not int or not 0 < meta['bytes'] <= MAX_BYTES
            or not isinstance(meta['sha256'], str) or not SHA.fullmatch(meta['sha256'])):
        raise Refused('HEADER_INVALID')
    if os.path.realpath(root) != os.path.abspath(root):
        raise Refused('ROOT_SYMLINK')
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    temp = None
    fd = None
    try:
        lock = os.open('.backup-receive.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,
                       0o600, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(lock).st_mode):
            raise Refused('LOCK_INVALID')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused('RECEIVER_BUSY')
        temp = '.' + meta['name'] + '.' + uuid.uuid4().hex + '.partial'
        fd = os.open(temp, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        remaining = meta['bytes']
        while remaining:
            chunk = stream.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise Refused('TRANSFER_TRUNCATED')
            view = memoryview(chunk)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise Refused('WRITE_FAILED')
                view = view[written:]
            remaining -= len(chunk)
        if stream.read(1):
            raise Refused('TRANSFER_OVERSIZED')
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        size, sha = digest_fd(fd)
        if (size, sha) != (meta['bytes'], meta['sha256']):
            raise Refused('HASH_MISMATCH')
        state = 'copied'
        try:
            os.link(temp, meta['name'], src_dir_fd=directory,
                    dst_dir_fd=directory, follow_symlinks=False)
        except FileExistsError:
            existing = os.open(meta['name'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                               dir_fd=directory)
            try:
                st = os.fstat(existing)
                if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600:
                    raise Refused('DESTINATION_INVALID')
                if digest_fd(existing) != (size, sha):
                    raise Refused('DESTINATION_CONFLICT')
            finally:
                os.close(existing)
            state = 'already_present'
        os.unlink(temp, dir_fd=directory)
        temp = None
        os.fsync(directory)
        pruned = prune(directory, keep=KEEP_COPIES, protect=meta['name'])
        return {'ok': True, 'state': state, 'name': meta['name'], 'bytes': size,
                'sha256': sha, 'copiesKept': KEEP_COPIES, 'pruned': pruned}
    finally:
        if fd is not None:
            os.close(fd)
        if temp is not None:
            os.unlink(temp, dir_fd=directory)
        if lock is not None:
            os.close(lock)
        os.close(directory)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 1:
            raise Refused('ARGUMENTS_FORBIDDEN')
        result = receive(sys.stdin.buffer)
    except Exception as error:
        code = str(error) if isinstance(error, Refused) else 'RECEIVER_FAILED'
        print(json.dumps({'ok': False, 'errorCode': code}), flush=True)
        sys.exit(1)
    print(json.dumps(result), flush=True)




