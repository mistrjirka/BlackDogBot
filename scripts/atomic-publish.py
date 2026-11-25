#!/usr/bin/env python3
"""Publish a staged directory atomically without replacing any destination.

Linux renameat2(RENAME_NOREPLACE) is required. No copy/unlink fallback is safe.
--check probes the kernel without creating, renaming, or removing any path.
"""
import ctypes
import errno
import json
import os
import stat
import sys


def result(status, **values):
    print(json.dumps({"protocolVersion": 1, "status": status, **values}))


def operation():
    if sys.platform != "linux":
        raise NotImplementedError("linux_required")
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise NotImplementedError("renameat2_unavailable")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    # Empty names cannot identify a file, so this probe cannot mutate anything.
    ctypes.set_errno(0)
    if rename(-100, b"", -100, b"", 1) != -1 or ctypes.get_errno() not in (errno.ENOENT, errno.EBADF):
        raise NotImplementedError("renameat2_unsupported")
    return rename


def main():
    rename = operation()
    if sys.argv[1:] == ["--check"]:
        result("supported")
        return 0
    if len(sys.argv) != 3 or not all(os.path.isabs(value) for value in sys.argv[1:]):
        result("failed", error="absolute_source_and_destination_required")
        return 2
    source, destination = map(os.path.normpath, sys.argv[1:])
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    source_fd = os.open(os.path.dirname(source), flags)
    try:
        destination_fd = os.open(os.path.dirname(destination), flags)
        try:
            source_name = os.path.basename(source)
            destination_name = os.path.basename(destination)
            if not source_name or not destination_name or not stat.S_ISDIR(os.stat(source_name, dir_fd=source_fd, follow_symlinks=False).st_mode):
                raise ValueError("staged_source_must_be_directory")
            if rename(source_fd, os.fsencode(source_name), destination_fd, os.fsencode(destination_name), 1) != 0:
                code = ctypes.get_errno()
                if code == errno.EEXIST:
                    result("failed", error="destination_exists")
                    return 3
                if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
                    raise NotImplementedError("atomic_no_replace_unsupported")
                raise OSError(code, "atomic_publish_failed")
            os.fsync(destination_fd)
            if destination_fd != source_fd:
                os.fsync(source_fd)
        finally:
            os.close(destination_fd)
    finally:
        os.close(source_fd)
    result("published")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except NotImplementedError:
        result("failed", error="linux_renameat2_required")
        sys.exit(4)
    except (OSError, ValueError) as error:
        result("failed", error="atomic_publish_failed", code=errno.errorcode.get(getattr(error, "errno", None), "INVALID"))
        sys.exit(2)
