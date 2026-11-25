#!/usr/bin/env python3
"""Hold supervisor and fixed activation flocks until the caller closes stdin."""
import fcntl
import os
import stat
import sys


def lock(directory, name):
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        if os.fstat(parent).st_mode & 0o022:
            raise ValueError("unsafe state directory")
        descriptor = os.open(name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
                             0o600, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
            raise ValueError("unsafe deployment lock")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def main():
    if len(sys.argv) not in (2, 3) or not all(os.path.isabs(value) for value in sys.argv[1:]):
        raise ValueError("absolute state directories required")
    descriptors = []
    try:
        descriptors.append(lock(sys.argv[1], "deploy.lock"))
        if len(sys.argv) == 3:
            descriptors.append(lock(sys.argv[2], "activation.lock"))
        print("locked", flush=True)
        while sys.stdin.buffer.read(1):
            pass
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError):
        sys.exit("Cannot hold the deployment lock. An upgrade may be running.")
