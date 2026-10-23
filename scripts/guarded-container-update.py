#!/usr/bin/env python3
"""Guarded upgrades for only the Scrapling and SearXNG Compose services.

Discovers upstream :latest digests but deploys only immutable image references,
with isolated canary probes and per-service rollback. No Docker socket exposure.
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
import urllib.request

SERVICES = {
    "scrapling": {"repository": "pyd4vinci/scrapling", "port": 18733, "canary_port": 18734, "inner_port": 8000},
    "searxng": {"repository": "searxng/searxng", "port": 18731, "canary_port": 18735, "inner_port": 8080},
}
IMAGE_LINE = re.compile(r"(?m)^(    image:\s*)(\S+)(\s*)$")
DIGEST_RE = re.compile(r"^[a-z0-9/_-]+@sha256:[a-f0-9]{64}$")


def command(args: list[str], timeout: int = 180) -> str:
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(f"Command failed ({args[0]} {args[1] if len(args)>1 else ''}): " + proc.stdout[-450:])
    return proc.stdout


def write_atomic(path: Path, data: str, mode: int = 0o600) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w") as out:
            out.write(data)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def replaced_image(compose_text: str, image: str, service: str = "scrapling") -> tuple[str, str]:
    """Replace only the named service's image. Unrelated services remain byte-identical."""
    if service not in SERVICES:
        raise ValueError(f"Unsupported service {service}")
    lines = compose_text.splitlines(keepends=True)
    header = "  " + service + ":"
    start = next((i for i, line in enumerate(lines) if line.rstrip() == header), None)
    if start is None:
        raise RuntimeError(f"{service} service absent from Compose")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if line.strip() and not line.startswith(" "):
            end = index
            break
        if re.match(r"^  [a-zA-Z0-9_-]+:", line):
            end = index
            break
    positions = [i for i in range(start + 1, end) if lines[i].startswith("    image:")]
    if len(positions) != 1:
        raise RuntimeError(f"{service} must have exactly one image field")
    index = positions[0]
    old = lines[index].split("image:", 1)[1].strip()
    lines[index] = "    image: " + image + "\n"
    return "".join(lines), old


def discover_latest(service: str) -> str:
    repo = SERVICES[service]["repository"]
    command(["docker", "pull", repo + ":latest"], timeout=900)
    digests = json.loads(command(["docker", "image", "inspect", repo + ":latest",
                                  "--format", "{{json .RepoDigests}}"]))
    image = next((d for d in digests if d.startswith(repo + "@sha256:")), None)
    if not image or not DIGEST_RE.fullmatch(image):
        raise RuntimeError(f"No official immutable digest found for {service}")
    return image


def check_for_update(compose: Path, service: str = "scrapling") -> dict[str, str]:
    current = replaced_image(compose.read_text(), SERVICES[service]["repository"] + "@sha256:" + "0" * 64, service)[1]
    candidate = discover_latest(service)
    return {"service": service, "status": "up_to_date" if current == candidate else "update_available",
            "current_image": current, "available_image": candidate}


def notify(chat_id: str | None, message: str) -> None:
    if not chat_id:
        return
    file = Path.home() / ".local/lib/blackdogbot/guarded-release.py"
    try:
        spec = importlib.util.spec_from_file_location("blackdog_guard", file)
        if spec is None or spec.loader is None:
            return
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.notify(Path.home() / ".blackdogbot/deploy", chat_id, message)
    except Exception:
        pass


def verify_scrapling(port: int, probe: Path) -> None:
    # This runs the actual MCP test: discovered tools, JS page, browser PNG.
    command(["node", str(probe), str(port)], timeout=150)


def verify_searxng(port: int) -> None:
    base = f"http://127.0.0.1:{port}"
    with urllib.request.urlopen(base + "/healthz", timeout=10) as response:
        if response.status != 200 or response.read(64).strip() != b"OK":
            raise RuntimeError("SearXNG /healthz failed")
    with urllib.request.urlopen(base + "/search?q=blackdogbot&format=json", timeout=25) as response:
        data = json.loads(response.read(3_000_000))
    if not isinstance(data, dict) or not isinstance(data.get("results"), list) or "query" not in data:
        raise RuntimeError("SearXNG JSON search API missing expected fields")


def verify(service: str, port: int, probe: Path) -> None:
    if service == "scrapling":
        verify_scrapling(port, probe)
    else:
        verify_searxng(port)


def start_canary(service: str, image: str, port: int, env_file: Path,
                 searx_settings: Path) -> str:
    name = "blackdog-" + service + "-update-canary"
    args = ["docker", "run", "-d", "--rm", "--name", name,
            "-p", f"127.0.0.1:{port}:{SERVICES[service]['inner_port']}"]
    if service == "scrapling":
        args += ["--shm-size", "1g", "--memory", "4g", "--pids-limit", "300",
                 "--env-file", str(env_file), image,
                 "mcp", "--http", "--host", "0.0.0.0", "--port", "8000"]
    else:
        if not searx_settings.is_file():
            raise FileNotFoundError(f"SearXNG settings unavailable: {searx_settings}")
        args += ["-v", f"{searx_settings}:/etc/searxng/settings.yml:ro",
                 "-e", f"SEARXNG_BASE_URL=http://127.0.0.1:{port}/", image]
    command(args, timeout=90)
    return name


def update(args: argparse.Namespace) -> dict[str, object]:
    service = args.service
    config = SERVICES[service]
    compose = args.compose.expanduser().resolve()
    probe = args.probe.expanduser().resolve()
    env_file = args.env_file.expanduser().resolve()
    searx_settings = args.searx_settings.expanduser().resolve()
    report_dir = args.report_dir.expanduser().resolve()
    report_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if service == "scrapling" and (not env_file.is_file() or env_file.stat().st_mode & 0o077):
        raise PermissionError("Scrapling credentials missing or not private (0600)")
    if service == "scrapling" and not probe.is_file():
        raise FileNotFoundError("Scrapling MCP probe missing from tested release")
    image = args.image or discover_latest(service)
    if not DIGEST_RE.fullmatch(image) or not image.startswith(str(config["repository"]) + "@sha256:"):
        raise ValueError(f"Expected official {service} SHA-256-pinned image")
    old_text = compose.read_text()
    new_text, previous = replaced_image(old_text, image, service)
    if old_text == new_text:
        return {"status": "unchanged", "service": service, "image": previous}
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + str(os.getpid())
    backup = report_dir / (stamp + "-" + service + ".yaml")
    shutil.copy2(compose, backup)
    os.chmod(backup, 0o600)
    outcome: dict[str, object] = {"status": "preparing", "service": service, "previous_image": previous,
                                  "candidate_image": image, "backup_compose": str(backup)}
    canary = "blackdog-" + service + "-update-canary"
    changed = False
    notify(args.chat_id, f"{service}: testing candidate Docker image; old production container unchanged.")
    try:
        command(["docker", "pull", image], timeout=900)
        start_canary(service, image, args.canary_port, env_file, searx_settings)
        for attempt in range(12):
            try:
                verify(service, args.canary_port, probe)
                break
            except Exception:
                if attempt == 11:
                    raise
                time.sleep(3)
        write_atomic(compose, new_text, compose.stat().st_mode & 0o777)
        changed = True
        command(["docker", "compose", "-f", str(compose), "config", "--quiet"])
        notify(args.chat_id, f"{service}: candidate passed; switching only this Compose service.")
        command(["docker", "compose", "-f", str(compose), "up", "-d", "--no-deps",
                 "--force-recreate", service], timeout=180)
        for attempt in range(12):
            try:
                verify(service, args.production_port, probe)
                break
            except Exception:
                if attempt == 11:
                    raise
                time.sleep(3)
        outcome["status"] = "healthy"
        notify(args.chat_id, f"{service}: Docker image update verified healthy; previous image retained for rollback.")
    except Exception as exc:
        outcome["error"] = type(exc).__name__ + ": " + str(exc)[:300]
        if changed:
            write_atomic(compose, old_text, backup.stat().st_mode & 0o777)
            try:
                command(["docker", "compose", "-f", str(compose), "up", "-d",
                         "--no-deps", "--force-recreate", service], timeout=180)
                for attempt in range(12):
                    try:
                        verify(service, args.production_port, probe)
                        break
                    except Exception:
                        if attempt == 11:
                            raise
                        time.sleep(3)
                outcome["status"] = "rolled_back"
            except Exception as rollback:
                outcome["status"] = "rollback_failed"
                outcome["rollback_error"] = type(rollback).__name__
        else:
            outcome["status"] = "prepare_failed"
        notify(args.chat_id, f"{service}: update {outcome['status']}; diagnostics retained in container reports.")
    finally:
        subprocess.run(["docker", "rm", "-f", canary], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        write_atomic(report_dir / (service + "-latest.json"), json.dumps(outcome, indent=2) + "\n")
        write_atomic(report_dir / (stamp + "-" + service + ".json"), json.dumps(outcome, indent=2) + "\n")
    return outcome


def main() -> int:
    parser = argparse.ArgumentParser(description="Update an MCP Docker service with a tested canary and rollback")
    parser.add_argument("--service", choices=tuple(SERVICES), default="scrapling")
    parser.add_argument("--image", help="Exact official image@sha256 digest; if omitted the latest digest is discovered")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--update-latest", action="store_true",
                        help="Discover and deploy the latest tested digest")
    parser.add_argument("--compose", type=Path, default=Path.home() / ".blackdogbot/docker-compose.yaml")
    parser.add_argument("--env-file", type=Path, default=Path.home() / ".blackdogbot/scrapling.env")
    parser.add_argument("--searx-settings", type=Path, default=Path.home() / ".blackdogbot/searxng/settings.yml")
    parser.add_argument("--probe", type=Path, default=Path.home() / ".blackdogbot/deploy/current/scripts/verify-scrapling.mjs")
    parser.add_argument("--report-dir", type=Path, default=Path.home() / ".blackdogbot/deploy/container-reports")
    parser.add_argument("--chat-id")
    parser.add_argument("--production-port", type=int)
    parser.add_argument("--canary-port", type=int)
    args = parser.parse_args()
    if args.production_port is None:
        args.production_port = SERVICES[args.service]["port"]
    if args.canary_port is None:
        args.canary_port = SERVICES[args.service]["canary_port"]
    if args.production_port == args.canary_port:
        parser.error("Canary port must not equal production port")
    try:
        known = json.loads((Path.home() / ".blackdogbot/known-telegram-chats.json").read_text())
        allowed = {str(v) for v in known if str(v).lstrip("-").isdigit()} if isinstance(known, list) else set()
    except (OSError, ValueError, TypeError):
        allowed = set()
    if args.chat_id is None and len(allowed) == 1:
        args.chat_id = next(iter(allowed))
    if args.chat_id is not None and args.chat_id not in allowed:
        parser.error("Notification chat is not in the bot's known chat list")
    if args.check_only:
        print(json.dumps(check_for_update(args.compose.expanduser().resolve(), args.service), indent=2))
        return 0
    if args.image is None and not args.update_latest:
        parser.error("Specify --image (pinned digest) or --update-latest")
    lock_path = Path.home() / ".blackdogbot/deploy/container-update.lock"
    lock_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = update(args)
    print("CONTAINER_DEPLOY_STATUS", args.service, result["status"])
    return 0 if result["status"] in ("healthy", "unchanged") else 2


if __name__ == "__main__":
    sys.exit(main())
