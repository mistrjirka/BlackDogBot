#!/usr/bin/env python3
"""Guarded, single-service Docker Compose upgrade for Scrapling.

Always runs outside BlackDogBot (use systemd-run --user). It stages the
new image on an isolated port and tests MCP before replacing anything.
It preserves the Compose file and previous image for rollback.
"""
from __future__ import annotations
import argparse
import datetime as dt
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

DIGEST_RE = re.compile(r"^pyd4vinci/scrapling@sha256:[a-f0-9]{64}$")
SCRAPER_BLOCK = re.compile(r"(?m)^(  scrapling:\n(?:(?!^  [a-zA-Z0-9_-]+:|^[^ \n]).*\n)*)")
IMAGE_LINE = re.compile(r"(?m)^(\s{4}image:\s*)(\S+)(\s*)$")
CANARY_NAME = "blackdog-scrapling-update-canary"


def command(args: list[str], timeout: int = 180) -> str:
    completed = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, timeout=timeout)
    if completed.returncode != 0:
        # Do not print raw process arguments: they may reference credential files.
        raise RuntimeError(f"Command failed ({args[0]} {args[1] if len(args)>1 else ''}): " +
                           completed.stdout[-600:])
    return completed.stdout


def write_atomic(path: Path, data: str, mode: int = 0o600) -> None:
    name = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w") as output:
            output.write(data)
        os.replace(name, path)
    finally:
        name.unlink(missing_ok=True)


def replaced_image(compose_text: str, image: str) -> tuple[str, str]:
    """Change only the Scrapling image; preserve every other service and comment."""
    match = SCRAPER_BLOCK.search(compose_text)
    if not match:
        raise RuntimeError("Scrapling service absent from Compose; install it first.")
    block = match.group(1)
    current = IMAGE_LINE.search(block)
    if not current:
        raise RuntimeError("Scrapling service has no image.")
    replacement = IMAGE_LINE.sub(lambda m: m.group(1) + image + m.group(3), block, count=1)
    return compose_text[:match.start()] + replacement + compose_text[match.end():], current.group(2)


def _guard_notify(chat_id: str | None, message: str) -> None:
    if not chat_id:
        return
    guard_file = Path.home() / ".local/lib/blackdogbot/guarded-release.py"
    try:
        spec = importlib.util.spec_from_file_location("blackdog_guard", guard_file)
        if not spec or not spec.loader:
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.notify(Path.home() / ".blackdogbot/deploy", chat_id, message)
    except Exception:
        pass


def verify_mcp(probe: Path, port: int) -> None:
    # The script does not print credentials; the probe reads the local 0600 env file.
    command(["node", str(probe), str(port)], timeout=150)


def update(args: argparse.Namespace) -> dict[str, str | bool]:
    if not DIGEST_RE.fullmatch(args.image):
        raise ValueError("Use official Scrapling image pinned to an immutable SHA-256 digest.")
    compose = args.compose.expanduser().resolve()
    probe = args.probe.expanduser().resolve()
    env_file = args.env_file.expanduser().resolve()
    report_dir = args.report_dir.expanduser().resolve()
    report_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not probe.is_file() or not env_file.is_file():
        raise FileNotFoundError("Scrapling probe or protected credentials file missing.")
    if env_file.stat().st_mode & 0o077:
        raise PermissionError("Scrapling credentials must have 0600 permissions.")
    prior_text = compose.read_text()
    next_text, current_image = replaced_image(prior_text, args.image)
    if next_text == prior_text:
        return {"status": "unchanged", "image": current_image}
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = report_dir / f"docker-compose-{stamp}-{os.getpid()}.yaml"
    shutil.copy2(compose, backup)
    os.chmod(backup, 0o600)
    result: dict[str, str | bool] = {
        "status": "preparing", "previous_image": current_image,
        "candidate_image": args.image, "backup_compose": str(backup),
        "rollback_image_preserved": True,
    }
    _guard_notify(args.chat_id, "Scrapling update: pulling and testing a new pinned Docker image. The current scraper remains online.")
    changed = False
    try:
        command(["docker", "pull", args.image], timeout=900)
        command(["docker", "image", "inspect", args.image])
        # Never pull "latest" when starting production: candidate is immutable.
        command(["docker", "run", "-d", "--rm", "--name", CANARY_NAME,
                 "--shm-size", "1g", "--memory", "4g", "--pids-limit", "300",
                 "-p", f"127.0.0.1:{args.canary_port}:8000", "--env-file", str(env_file),
                 args.image, "mcp", "--http", "--host", "0.0.0.0", "--port", "8000"], timeout=80)
        # Startup can take a moment on some machines.
        for retry in range(12):
            try:
                verify_mcp(probe, args.canary_port)
                break
            except Exception:
                if retry == 11:
                    raise
                time.sleep(3)

        write_atomic(compose, next_text, compose.stat().st_mode & 0o777)
        changed = True
        command(["docker", "compose", "-f", str(compose), "config", "--quiet"])
        _guard_notify(args.chat_id, "Scrapling update: candidate MCP/browser tests passed. Activating only the Scrapling container.")
        command(["docker", "compose", "-f", str(compose), "up", "-d", "--no-deps",
                 "--force-recreate", "scrapling"], timeout=160)
        for retry in range(12):
            try:
                verify_mcp(probe, args.production_port)
                break
            except Exception:
                if retry == 11:
                    raise
                time.sleep(3)
        result["status"] = "healthy"
        _guard_notify(args.chat_id, "Scrapling update healthy: JavaScript rendering, MCP access, and screenshot checks passed. Previous image and Compose backup retained.")
    except Exception as error:
        result["error"] = type(error).__name__ + ": " + str(error)[:320]
        if changed:
            write_atomic(compose, prior_text, backup.stat().st_mode & 0o777)
            try:
                command(["docker", "compose", "-f", str(compose), "up", "-d",
                         "--no-deps", "--force-recreate", "scrapling"], timeout=160)
                for retry in range(10):
                    try:
                        verify_mcp(probe, args.production_port)
                        break
                    except Exception:
                        if retry == 9:
                            raise
                        time.sleep(3)
                result["status"] = "rolled_back"
            except Exception as restore_error:
                result["status"] = "rollback_failed"
                result["rollback_error"] = type(restore_error).__name__
        else:
            result["status"] = "prepare_failed"
        _guard_notify(args.chat_id, f"Scrapling update {result['status']}: previous image retained, diagnostics saved under {report_dir}.")
    finally:
        # Only the named temporary container, never arbitrary Docker processes.
        subprocess.run(["docker", "rm", "-f", CANARY_NAME],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        write_atomic(report_dir / "latest.json", json.dumps(result, indent=2) + "\n")
        write_atomic(report_dir / f"{stamp}-{os.getpid()}.json", json.dumps(result, indent=2) + "\n")
    return result


def check_for_update(compose: Path) -> dict[str, str]:
    """Refresh only the local floating tag, report digest difference without restarting Docker."""
    _, current = replaced_image(compose.read_text(), "pyd4vinci/scrapling@sha256:" + "0" * 64)
    command(["docker", "pull", "pyd4vinci/scrapling:latest"], timeout=900)
    digests = json.loads(command(["docker", "image", "inspect", "pyd4vinci/scrapling:latest",
                                  "--format", "{{json .RepoDigests}}"]))
    candidate = next((d for d in digests if d.startswith("pyd4vinci/scrapling@sha256:")), None)
    if candidate is None:
        raise RuntimeError("Could not resolve official Scrapling repository digest")
    return {"status": "up_to_date" if current == candidate else "update_available",
            "current_image": current, "available_image": candidate}


def main() -> int:
    parser = argparse.ArgumentParser(description="Guarded Scrapling container image upgrade")
    parser.add_argument("--image", help="pyd4vinci/scrapling@sha256:... (required for upgrades)")
    parser.add_argument("--check-only", action="store_true", help="Check registry and return candidate digest; no container restart")
    parser.add_argument("--compose", type=Path, default=Path.home() / ".blackdogbot/docker-compose.yaml")
    parser.add_argument("--env-file", type=Path, default=Path.home() / ".blackdogbot/scrapling.env")
    parser.add_argument("--probe", type=Path, default=Path.home() / "programy/better-claw/scripts/verify-scrapling.mjs")
    parser.add_argument("--report-dir", type=Path, default=Path.home() / ".blackdogbot/deploy/container-reports")
    parser.add_argument("--chat-id")
    parser.add_argument("--production-port", type=int, default=18733)
    parser.add_argument("--canary-port", type=int, default=18734)
    args = parser.parse_args()
    # Only notify chats already known to the bot. Auto-select the sole chat.
    try:
        known = json.loads((Path.home() / ".blackdogbot/known-telegram-chats.json").read_text())
        allowed = {str(value) for value in known if str(value).lstrip("-").isdigit()} if isinstance(known, list) else set()
    except (OSError, ValueError, TypeError):
        allowed = set()
    if args.chat_id is None and len(allowed) == 1:
        args.chat_id = next(iter(allowed))
    if args.chat_id is not None and args.chat_id not in allowed:
        parser.error("Telegram notification chat is not in the bot\'s known chats.")
    if args.check_only:
        print(json.dumps(check_for_update(args.compose.expanduser().resolve()), indent=2))
        return 0
    if not args.image:
        parser.error("An immutable --image digest is required for upgrades.")
    if args.production_port == args.canary_port:
        parser.error("Canary and production ports must differ.")
    lock_path = Path.home() / ".blackdogbot/deploy/container-update.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = update(args)
        print("SCRAPLING_DEPLOY_STATUS", result["status"])
        return 0 if result["status"] in ("healthy", "unchanged") else 2


if __name__ == "__main__":
    sys.exit(main())
